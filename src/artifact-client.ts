import * as core from '@actions/core'
import crypto from 'crypto'
import {join, normalize, resolve} from 'path'
import * as fs from 'fs'
import * as tmp from 'tmp-promise'
import {HttpClient, HttpClientResponse} from '@actions/http-client'
import {BearerCredentialHandler} from '@actions/http-client/lib/auth'
import { promisify } from 'util'
import * as zlib from 'zlib'
import CRC64 from './CRC64'
import { IncomingHttpHeaders } from 'http'
const stat = promisify(fs.stat)

interface PatchArtifactSize {
  Size: number
}

interface StreamDigest {
  crc64: string
  md5: string
}

interface UploadFileParameters {
  file: string
  resourceUrl: string
  maxChunkSize: number
  continueOnError: boolean
}

interface UploadFileResult {
  isSuccess: boolean
  successfulUploadSize: number
  totalSize: number
}

export interface ArtifactResponse {
  containerId: string
  size: number
  signedContent: string
  fileContainerResourceUrl: string
  type: string
  name: string
  url: string
}

export interface CreateArtifactParameters {
  Type: string
  Name: string
  RetentionDays?: number
}

interface UploadResults {
  /**
   * The size in bytes of data that was transferred during the upload process to the actions backend service. This takes into account possible
   * gzip compression to reduce the amount of data that needs to be transferred
   */
  uploadSize: number

  /**
   * The raw size of the files that were specified for upload
   */
  totalSize: number

  /**
   * An array of files that failed to upload
   */
  failedItems: string[]
}

interface UploadResponse {
  /**
   * The name of the artifact that was uploaded
   */
  artifactName: string

  /**
   * A list of all items that are meant to be uploaded as part of the artifact
   */
  artifactItems: string[]

  /**
   * Total size of the artifact in bytes that was uploaded
   */
  size: number

  /**
   * A list of items that were not uploaded as part of the artifact (includes queued items that were not uploaded if
   * continueOnError is set to false). This is a subset of artifactItems.
   */
  failedItems: string[]

	containerUrl: string
}

async function sleep(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function getExponentialRetryTimeInMilliseconds(
	retryCount: number
): number {	
	const minTime =
		10 * 1.5 * retryCount
	const maxTime = minTime * 1.5

	// returns a random number between the minTime (inclusive) and the maxTime (exclusive)
	return Math.trunc(Math.random() * (maxTime - minTime) + minTime)
}

function isSuccessStatusCode(statusCode?: number): boolean {
	if (!statusCode) {
		return false
	}
	return statusCode >= 200 && statusCode < 300
}

function isThrottledStatusCode(statusCode?: number): boolean {
  if (!statusCode) {
    return false
  }
  return statusCode === HttpCodes.TooManyRequests
}

function isRetryableStatusCode(statusCode: number | undefined): boolean {
	if (!statusCode) {
		return false
	}

	const retryableStatusCodes = [
		HttpCodes.BadGateway,
		HttpCodes.GatewayTimeout,
		HttpCodes.InternalServerError,
		HttpCodes.ServiceUnavailable,
		HttpCodes.TooManyRequests,
		413 // Payload Too Large
	]
	return retryableStatusCodes.includes(statusCode)
}

function tryGetRetryAfterValueTimeInMilliseconds(
  headers: IncomingHttpHeaders
): number | undefined {
  if (headers['retry-after']) {
    const retryTime = Number(headers['retry-after'])
    if (!isNaN(retryTime)) {
      core.info(`Retry-After header is present with a value of ${retryTime}`)
      return retryTime * 1000
    }
    core.info(
      `Returned retry-after header value: ${retryTime} is non-numeric and cannot be used`
    )
    return undefined
  }
  core.info(
    `No retry-after header was found. Dumping all headers for diagnostic purposes`
  )
  // eslint-disable-next-line no-console
  console.log(headers)
  return undefined
}

export async function retry(
  name: string,
  operation: () => Promise<HttpClientResponse>,
  customErrorMessages: Map<number, string>,
  maxAttempts: number
): Promise<HttpClientResponse> {
  let response: HttpClientResponse | undefined = undefined
  let statusCode: number | undefined = undefined
  let isRetryable = false
  let errorMessage = ''
  let customErrorInformation: string | undefined = undefined
  let attempt = 1

  while (attempt <= maxAttempts) {
    try {
      response = await operation()
      statusCode = response.message.statusCode

      if (isSuccessStatusCode(statusCode)) {
        return response
      }

      // Extra error information that we want to display if a particular response code is hit
      if (statusCode) {
        customErrorInformation = customErrorMessages.get(statusCode)
      }

      isRetryable = isRetryableStatusCode(statusCode)
      errorMessage = `Artifact service responded with ${statusCode}`
    } catch (error) {
      isRetryable = true
      errorMessage = (error as any).message
    }

    if (!isRetryable) {
      core.info(`${name} - Error is not retryable`)
      if (response?.message.statusMessage) {
        core.info(response.message.statusMessage)
      }
      break
    }

    core.info(
      `${name} - Attempt ${attempt} of ${maxAttempts} failed with error: ${errorMessage}`
    )

    await sleep(getExponentialRetryTimeInMilliseconds(attempt))
    attempt++
  }

  if (response?.message.statusMessage) {
    core.info(response?.message.statusMessage)
  }

  if (customErrorInformation) {
    throw Error(`${name} failed: ${customErrorInformation}`)
  }
  throw Error(`${name} failed: ${errorMessage}`)
}

export async function retryHttpClientRequest(
  name: string,
  method: () => Promise<HttpClientResponse>,
  customErrorMessages: Map<number, string> = new Map(),
  maxAttempts = 5
): Promise<HttpClientResponse> {
  return await retry(name, method, customErrorMessages, maxAttempts)
}

export enum HttpCodes {
  OK = 200,
  MultipleChoices = 300,
  MovedPermanently = 301,
  ResourceMoved = 302,
  SeeOther = 303,
  NotModified = 304,
  UseProxy = 305,
  SwitchProxy = 306,
  TemporaryRedirect = 307,
  PermanentRedirect = 308,
  BadRequest = 400,
  Unauthorized = 401,
  PaymentRequired = 402,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  NotAcceptable = 406,
  ProxyAuthenticationRequired = 407,
  RequestTimeout = 408,
  Conflict = 409,
  Gone = 410,
  TooManyRequests = 429,
  InternalServerError = 500,
  NotImplemented = 501,
  BadGateway = 502,
  ServiceUnavailable = 503,
  GatewayTimeout = 504
}

export function getRuntimeUrl(): string {
  const runtimeUrl = process.env['ACTIONS_RUNTIME_URL']
  if (!runtimeUrl) {
    throw new Error('Unable to get ACTIONS_RUNTIME_URL env variable')
  }
  return runtimeUrl
}

export function getWorkFlowRunId(): string {
  const workFlowRunId = process.env['GITHUB_RUN_ID']
  if (!workFlowRunId) {
    throw new Error('Unable to get GITHUB_RUN_ID env variable')
  }
  return workFlowRunId
}

function getRuntimeToken(): string {
  const token = process.env['ACTIONS_RUNTIME_TOKEN']
  if (!token) {
    throw new Error('Unable to get ACTIONS_RUNTIME_TOKEN env variable')
  }
  return token
}

export function getApiVersion(): string {
  return '6.0-preview'
}

function createHttpClient(userAgent: string): HttpClient {
  return new HttpClient(userAgent, [
    new BearerCredentialHandler(getRuntimeToken())
  ])
}

export function getArtifactUrl(): string {
  const artifactUrl = `${getRuntimeUrl()}_apis/pipelines/workflows/${getWorkFlowRunId()}/artifacts?api-version=${getApiVersion()}`
  core.info(`Artifact Url: ${artifactUrl}`)
  return artifactUrl
}

export function getUploadHeaders(
  contentType: string,
  isKeepAlive?: boolean,
	isGzip?: boolean,
  uncompressedLength?: number,
  contentLength?: number,
  contentRange?: string,
  digest?: StreamDigest
) {
  const requestOptions = {}
  requestOptions['Accept'] = `application/json;api-version=${getApiVersion()}`
  if (contentType) {
    requestOptions['Content-Type'] = contentType
  }
  if (isKeepAlive) {
    requestOptions['Connection'] = 'Keep-Alive'
    // keep alive for at least 10 seconds before closing the connection
    requestOptions['Keep-Alive'] = '10'
  }
  if (isKeepAlive) {
    requestOptions['Connection'] = 'Keep-Alive'
    // keep alive for at least 10 seconds before closing the connection
    requestOptions['Keep-Alive'] = '10'
  }
  if (isGzip) {
    requestOptions['Content-Encoding'] = 'gzip'
    requestOptions['x-tfs-filelength'] = uncompressedLength
  }
  if (contentLength) {
    requestOptions['Content-Length'] = contentLength
  }
  if (contentRange) {
    requestOptions['Content-Range'] = contentRange
  }
  if (digest) {
    requestOptions['x-actions-results-crc64'] = digest.crc64
    requestOptions['x-actions-results-md5'] = digest.md5
  }

  return requestOptions
}

export class UploadHttpClient {
	private uploadHttpManagerClient

  constructor() {
    this.uploadHttpManagerClient = createHttpClient('@actions/artifact-upload')
  }

	private async uploadChunk(
    httpClientIndex: number,
    resourceUrl: string,
    openStream: () => NodeJS.ReadableStream,
    start: number,
    end: number,
    uploadFileSize: number,
    isGzip: boolean,
    totalFileSize: number
  ): Promise<boolean> {
    // open a new stream and read it to compute the digest

		async function digestForStream(
			stream: NodeJS.ReadableStream
		): Promise<StreamDigest> {
			return new Promise((resolve, reject) => {
				const crc64 = new CRC64()
				const md5 = crypto.createHash('md5')
				stream
					.on('data', data => {
						crc64.update(data)
						md5.update(data)
					})
					.on('end', () =>
						resolve({
							crc64: crc64.digest('base64') as string,
							md5: md5.digest('base64')
						})
					)
					.on('error', reject)
			})
		}

    const digest = await digestForStream(openStream())

    // prepare all the necessary headers before making any http call
    const headers = getUploadHeaders(
      'application/octet-stream',
      true,
      isGzip,
      totalFileSize,
      end - start + 1,
      `bytes ${start}-${end}/${uploadFileSize}`,
      digest
    )

    const uploadChunkRequest = async (): Promise<HttpClientResponse> => {
      const client = this.uploadHttpManagerClient
      return await client.sendStream('PUT', resourceUrl, openStream(), headers)
    }

    let retryCount = 0
    const retryLimit = 5

    // Increments the current retry count and then checks if the retry limit has been reached
    // If there have been too many retries, fail so the download stops
    const incrementAndCheckRetryLimit = ( ): boolean => {
      retryCount++
      if (retryCount > retryLimit) {
        core.info(
          `Retry limit has been reached for chunk at offset ${start} to ${resourceUrl}`
        )
        return true
      }
      return false
    }

    const backOff = async (retryAfterValue?: number): Promise<void> => {
      if (retryAfterValue) {
        core.info(
          `Backoff due to too many requests, retry #${retryCount}. Waiting for ${retryAfterValue} milliseconds before continuing the upload`
        )
        await sleep(retryAfterValue)
      } else {
        const backoffTime = getExponentialRetryTimeInMilliseconds(retryCount)
        core.info(
          `Exponential backoff for retry #${retryCount}. Waiting for ${backoffTime} milliseconds before continuing the upload at offset ${start}`
        )
        await sleep(backoffTime)
      }
      core.info(
        `Finished backoff for retry #${retryCount}, continuing with upload`
      )
      return
    }

    // allow for failed chunks to be retried multiple times
    while (retryCount <= retryLimit) {
      let response: HttpClientResponse

      try {
        response = await uploadChunkRequest()
      } catch (error) {
        // if an error is caught, it is usually indicative of a timeout so retry the upload
        core.info(
          `An error has been caught http-client index ${httpClientIndex}, retrying the upload`
        )
        // eslint-disable-next-line no-console
        console.log(error)

        if (incrementAndCheckRetryLimit()) {
          return false
        }
        await backOff()
        continue
      }

      // Always read the body of the response. There is potential for a resource leak if the body is not read which will
      // result in the connection remaining open along with unintended consequences when trying to dispose of the client
      await response.readBody()

      if (isSuccessStatusCode(response.message.statusCode)) {
        return true
      } else if (isRetryableStatusCode(response.message.statusCode)) {
        core.info(
          `A ${response.message.statusCode} status code has been received, will attempt to retry the upload`
        )
        if (incrementAndCheckRetryLimit()) {
          return false
        }
        isThrottledStatusCode(response.message.statusCode)
          ? await backOff(
              tryGetRetryAfterValueTimeInMilliseconds(response.message.headers)
            )
          : await backOff()
      } else {
        core.error(
          `Unexpected response. Unable to upload chunk to ${resourceUrl}`
        )
        return false
      }
    }
    return false
  }

	private async uploadFileAsync(
    httpClientIndex: number,
    parameters: UploadFileParameters
  ): Promise<UploadFileResult> {
    const fileStat: fs.Stats = await stat(parameters.file)
    const totalFileSize = fileStat.size
    const isFIFO = fileStat.isFIFO()
    let offset = 0
    let isUploadSuccessful = true
    let failedChunkSizes = 0
    let uploadFileSize = 0
    let isGzip = true

		async function createGZipFileOnDisk(
			originalFilePath: string,
			tempFilePath: string
		): Promise<number> {
			return new Promise((resolve, reject) => {
				const inputStream = fs.createReadStream(originalFilePath)
				const gzip = zlib.createGzip()
				const outputStream = fs.createWriteStream(tempFilePath)
				inputStream.pipe(gzip).pipe(outputStream)
				outputStream.on('finish', async () => {
					// wait for stream to finish before calculating the size which is needed as part of the Content-Length header when starting an upload
					const size = (await stat(tempFilePath)).size
					resolve(size)
				})
				outputStream.on('error', error => {
					// eslint-disable-next-line no-console
					console.log(error)
					reject(error)
				})
			})
		}

    {
      // the file that is being uploaded is greater than 64k in size, a temporary file gets created on disk using the
      // npm tmp-promise package and this file gets used to create a GZipped file
      const tempFile = await tmp.file()
      core.debug(
        `${parameters.file} is greater than 64k in size. Creating a gzip file on-disk ${tempFile.path} to potentially reduce the upload size`
      )

      // create a GZip file of the original file being uploaded, the original file should not be modified in any way
      uploadFileSize = await createGZipFileOnDisk(
        parameters.file,
        tempFile.path
      )

      let uploadFilePath = tempFile.path

      // compression did not help with size reduction, use the original file for upload and delete the temp GZip file
      // for named pipes totalFileSize is zero, this assumes compression did help
      if (!isFIFO && totalFileSize < uploadFileSize) {
        core.debug(
          `The gzip file created for ${parameters.file} did not help with reducing the size of the file. The original file will be uploaded as-is`
        )
        uploadFileSize = totalFileSize
        uploadFilePath = parameters.file
        isGzip = false
      } else {
        core.debug(
          `The gzip file created for ${parameters.file} is smaller than the original file. The file will be uploaded using gzip.`
        )
      }

      let abortFileUpload = false
      // upload only a single chunk at a time
      while (offset < uploadFileSize) {
        const chunkSize = Math.min(
          uploadFileSize - offset,
          parameters.maxChunkSize
        )

        const startChunkIndex = offset
        const endChunkIndex = offset + chunkSize - 1
        offset += parameters.maxChunkSize

        if (abortFileUpload) {
          // if we don't want to continue in the event of an error, any pending upload chunks will be marked as failed
          failedChunkSizes += chunkSize
          continue
        }

        const result = await this.uploadChunk(
          httpClientIndex,
          parameters.resourceUrl,
          () =>
            fs.createReadStream(uploadFilePath, {
              start: startChunkIndex,
              end: endChunkIndex,
              autoClose: false
            }),
          startChunkIndex,
          endChunkIndex,
          uploadFileSize,
          isGzip,
          totalFileSize
        )

        if (!result) {
          // Chunk failed to upload, report as failed and do not continue uploading any more chunks for the file. It is possible that part of a chunk was
          // successfully uploaded so the server may report a different size for what was uploaded
          isUploadSuccessful = false
          failedChunkSizes += chunkSize
          core.warning(`Aborting upload for ${parameters.file} due to failure`)
          abortFileUpload = true
        }
      }

      // Delete the temporary file that was created as part of the upload. If the temp file does not get manually deleted by
      // calling cleanup, it gets removed when the node process exits. For more info see: https://www.npmjs.com/package/tmp-promise#about
      core.debug(`deleting temporary gzip file ${tempFile.path}`)
      await tempFile.cleanup()

      return {
        isSuccess: isUploadSuccessful,
        successfulUploadSize: uploadFileSize - failedChunkSizes,
        totalSize: totalFileSize
      }
    }
  }

	async createArtifactInFileContainer(
    artifactName: string,
  ): Promise<ArtifactResponse> {
    const parameters: CreateArtifactParameters = {
      Type: 'actions_storage',
      Name: artifactName,
			RetentionDays: 1,
    }

    const data: string = JSON.stringify(parameters, null, 2)
    const artifactUrl = getArtifactUrl()

    // use the first client from the httpManager, `keep-alive` is not used so the connection will close immediately
    const client = this.uploadHttpManagerClient
    const headers = getUploadHeaders('application/json', false)

    // Extra information to display when a particular HTTP code is returned
    // If a 403 is returned when trying to create a file container, the customer has exceeded
    // their storage quota so no new artifact containers can be created
    const customErrorMessages: Map<number, string> = new Map([
      [
        HttpCodes.Forbidden,
        'Artifact storage quota has been hit. Unable to upload any new artifacts'
      ],
      [
        HttpCodes.BadRequest,
        `The artifact name ${artifactName} is not valid. Request URL ${artifactUrl}`
      ]
    ])

    const response = await retryHttpClientRequest(
      'Create Artifact Container',
      async () => client.post(artifactUrl, data, headers),
      customErrorMessages
    )
    const body: string = await response.readBody()
    return JSON.parse(body)
  }

	async patchArtifactSize(size: number, artifactName: string): Promise<void> {
    const resourceUrl = new URL(getArtifactUrl())
    resourceUrl.searchParams.append('artifactName', artifactName)

    const parameters: PatchArtifactSize = {Size: size}
    const data: string = JSON.stringify(parameters, null, 2)
    core.debug(`URL is ${resourceUrl.toString()}`)

    const client = this.uploadHttpManagerClient
    const headers = getUploadHeaders('application/json', false)

    // Extra information to display when a particular HTTP code is returned
    const customErrorMessages: Map<number, string> = new Map([
      [
        HttpCodes.NotFound,
        `An Artifact with the name ${artifactName} was not found`
      ]
    ])

    // TODO retry for all possible response codes, the artifact upload is pretty much complete so it at all costs we should try to finish this
    const response = await retryHttpClientRequest(
      'Finalize artifact upload',
      async () => client.patch(resourceUrl.toString(), data, headers),
      customErrorMessages
    )
    await response.readBody()
    core.debug(
      `Artifact ${artifactName} has been successfully uploaded, total size in bytes: ${size}`
    )
  }

	async uploadArtifactToFileContainer(
    uploadUrl: string,
    filesToUpload: UploadSpecification[],
  ): Promise<UploadResults> {
    const FILE_CONCURRENCY = 1
    const MAX_CHUNK_SIZE = 4 * 1024 * 1024 // 4 MB Chunks
    core.debug(
      `File Concurrency: ${FILE_CONCURRENCY}, and Chunk Size: ${MAX_CHUNK_SIZE}`
    )

    const parameters: UploadFileParameters[] = []
    // by default, file uploads will continue if there is an error unless specified differently in the options
    let continueOnError = false

    // prepare the necessary parameters to upload all the files
    for (const file of filesToUpload) {
      const resourceUrl = new URL(uploadUrl)
      resourceUrl.searchParams.append('itemPath', file.uploadFilePath)
      parameters.push({
        file: file.absoluteFilePath,
        resourceUrl: resourceUrl.toString(),
        maxChunkSize: MAX_CHUNK_SIZE,
        continueOnError
      })
    }

    const parallelUploads = [...new Array(FILE_CONCURRENCY).keys()]
    const failedItemsToReport: string[] = []
    let currentFile = 0
    let completedFiles = 0
    let uploadFileSize = 0
    let totalFileSize = 0
    let abortPendingFileUploads = false

    // this.statusReporter.setTotalNumberOfFilesToProcess(filesToUpload.length)
    // this.statusReporter.start()

    // only allow a certain amount of files to be uploaded at once, this is done to reduce potential errors
    await Promise.all(
      parallelUploads.map(async index => {
        while (currentFile < filesToUpload.length) {
          const currentFileParameters = parameters[currentFile]
          currentFile += 1
          if (abortPendingFileUploads) {
            failedItemsToReport.push(currentFileParameters.file)
            continue
          }

          const startTime = performance.now()
          const uploadFileResult = await this.uploadFileAsync(
            index,
            currentFileParameters
          )

          if (core.isDebug()) {
            core.debug(
              `File: ${++completedFiles}/${filesToUpload.length}. ${
                currentFileParameters.file
              } took ${(performance.now() - startTime).toFixed(
                3
              )} milliseconds to finish upload`
            )
          }

          uploadFileSize += uploadFileResult.successfulUploadSize
          totalFileSize += uploadFileResult.totalSize
          if (uploadFileResult.isSuccess === false) {
            failedItemsToReport.push(currentFileParameters.file)
            if (!continueOnError) {
              // fail fast
              core.error(`aborting artifact upload`)
              abortPendingFileUploads = true
            }
          }
        }
      })
    )

    core.info(`Total size of all the files uploaded is ${uploadFileSize} bytes`)
    return {
      uploadSize: uploadFileSize,
      totalSize: totalFileSize,
      failedItems: failedItemsToReport
    }
  }
}

const invalidArtifactFilePathCharacters = new Map<string, string>([
  ['"', ' Double quote "'],
  [':', ' Colon :'],
  ['<', ' Less than <'],
  ['>', ' Greater than >'],
  ['|', ' Vertical bar |'],
  ['*', ' Asterisk *'],
  ['?', ' Question mark ?'],
  ['\r', ' Carriage return \\r'],
  ['\n', ' Line feed \\n']
])

export function checkArtifactFilePath(path: string): void {
  if (!path) {
    throw new Error(`Artifact path: ${path}, is incorrectly provided`)
  }

  for (const [
    invalidCharacterKey,
    errorMessageForCharacter
  ] of invalidArtifactFilePathCharacters) {
    if (path.includes(invalidCharacterKey)) {
      throw new Error(
        `Artifact path is not valid: ${path}. Contains the following character: ${errorMessageForCharacter}
          
Invalid characters include: ${Array.from(
          invalidArtifactFilePathCharacters.values()
        ).toString()}
          
The following characters are not allowed in files that are uploaded due to limitations with certain file systems such as NTFS. To maintain file system agnostic behavior, these characters are intentionally not allowed to prevent potential problems with downloads on different file systems.
          `
      )
    }
  }
}

export interface UploadSpecification {
  absoluteFilePath: string
  uploadFilePath: string
}

export function getUploadSpecification(
  artifactName: string,
  rootDirectory: string,
  artifactFiles: string[]
): UploadSpecification[] {
  // artifact name was checked earlier on, no need to check again
  const specifications: UploadSpecification[] = []

  if (!fs.existsSync(rootDirectory)) {
    throw new Error(`Provided rootDirectory ${rootDirectory} does not exist`)
  }
  if (!fs.statSync(rootDirectory).isDirectory()) {
    throw new Error(
      `Provided rootDirectory ${rootDirectory} is not a valid directory`
    )
  }
  // Normalize and resolve, this allows for either absolute or relative paths to be used
  rootDirectory = normalize(rootDirectory)
  rootDirectory = resolve(rootDirectory)

  /*
     Example to demonstrate behavior
     
     Input:
       artifactName: my-artifact
       rootDirectory: '/home/user/files/plz-upload'
       artifactFiles: [
         '/home/user/files/plz-upload/file1.txt',
         '/home/user/files/plz-upload/file2.txt',
         '/home/user/files/plz-upload/dir/file3.txt'
       ]
     
     Output:
       specifications: [
         ['/home/user/files/plz-upload/file1.txt', 'my-artifact/file1.txt'],
         ['/home/user/files/plz-upload/file1.txt', 'my-artifact/file2.txt'],
         ['/home/user/files/plz-upload/file1.txt', 'my-artifact/dir/file3.txt']
       ]
  */
  for (let file of artifactFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`File ${file} does not exist`)
    }
    if (!fs.statSync(file).isDirectory()) {
      // Normalize and resolve, this allows for either absolute or relative paths to be used
      file = normalize(file)
      file = resolve(file)
      if (!file.startsWith(rootDirectory)) {
        throw new Error(
          `The rootDirectory: ${rootDirectory} is not a parent directory of the file: ${file}`
        )
      }

      // Check for forbidden characters in file paths that will be rejected during upload
      const uploadPath = file.replace(rootDirectory, '')
      checkArtifactFilePath(uploadPath)

      /*
        uploadFilePath denotes where the file will be uploaded in the file container on the server. During a run, if multiple artifacts are uploaded, they will all
        be saved in the same container. The artifact name is used as the root directory in the container to separate and distinguish uploaded artifacts

        path.join handles all the following cases and would return 'artifact-name/file-to-upload.txt
          join('artifact-name/', 'file-to-upload.txt')
          join('artifact-name/', '/file-to-upload.txt')
          join('artifact-name', 'file-to-upload.txt')
          join('artifact-name', '/file-to-upload.txt')
      */
      specifications.push({
        absoluteFilePath: file,
        uploadFilePath: join(artifactName, uploadPath)
      })
    } else {
      // Directories are rejected by the server during upload
      console.log(`Removing ${file} from rawSearchResults because it is a directory`)
    }
  }
  return specifications
}

export interface ArtifactClient {
  /**
   * Uploads an artifact
   *
   * @param name the name of the artifact, required
   * @param files a list of absolute or relative paths that denote what files should be uploaded
   * @param rootDirectory an absolute or relative file path that denotes the root parent directory of the files being uploaded
   * @param options extra options for customizing the upload behavior
   * @returns single UploadInfo object
   */
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
  ): Promise<UploadResponse>
}

export class DefaultArtifactClient implements ArtifactClient {
  /**
   * Constructs a DefaultArtifactClient
   */
  static create(): DefaultArtifactClient {
    return new DefaultArtifactClient()
  }

  /**
   * Uploads an artifact
   */
  async uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
  ): Promise<UploadResponse> {
    core.info(
      `Starting artifact upload
For more detailed logs during the artifact upload process, enable step-debugging: https://docs.github.com/actions/monitoring-and-troubleshooting-workflows/enabling-debug-logging#enabling-step-debug-logging`
    )

    // Get specification for the files being uploaded
    const uploadSpecification: UploadSpecification[] = getUploadSpecification(
      name,
      rootDirectory,
      files
    )
    const uploadResponse: UploadResponse = {
      artifactName: name,
      artifactItems: [],
      size: 0,
      failedItems: [],
			containerUrl: ''
    }

    const uploadHttpClient = new UploadHttpClient()

    if (uploadSpecification.length === 0) {
      core.warning(`No files found that can be uploaded`)
    } else {
      // Create an entry for the artifact in the file container
      const response = await uploadHttpClient.createArtifactInFileContainer(
        name
      )
      if (!response.fileContainerResourceUrl) {
        core.debug(response.toString())
        throw new Error(
          'No URL provided by the Artifact Service to upload an artifact to'
        )
      }

      core.debug(`Upload Resource URL: ${response.fileContainerResourceUrl}`)
      core.info(
        `Container for artifact "${name}" successfully created. Starting upload of file(s)`
      )

      // Upload each of the files that were found concurrently
      const uploadResult = await uploadHttpClient.uploadArtifactToFileContainer(
        response.fileContainerResourceUrl,
        uploadSpecification,
      )

      // Update the size of the artifact to indicate we are done uploading
      // The uncompressed size is used for display when downloading a zip of the artifact from the UI
      core.info(
        `File upload process has finished. Finalizing the artifact upload`
      )
      await uploadHttpClient.patchArtifactSize(uploadResult.totalSize, name)

      if (uploadResult.failedItems.length > 0) {
        core.info(
          `Upload finished. There were ${uploadResult.failedItems.length} items that failed to upload`
        )
      } else {
        core.info(
          `Artifact has been finalized. All files have been successfully uploaded!`
        )
      }

      core.info(
        `
The raw size of all the files that were specified for upload is ${uploadResult.totalSize} bytes
The size of all the files that were uploaded is ${uploadResult.uploadSize} bytes. This takes into account any gzip compression used to reduce the upload size, time and storage

Note: The size of downloaded zips can differ significantly from the reported size. For more information see: https://github.com/actions/upload-artifact#zipped-artifact-downloads \r\n`
      )

      uploadResponse.artifactItems = uploadSpecification.map(
        item => item.absoluteFilePath
      )
      uploadResponse.size = uploadResult.uploadSize
      uploadResponse.failedItems = uploadResult.failedItems
			uploadResponse.containerUrl = response.fileContainerResourceUrl
    }
    return uploadResponse
  }
}
