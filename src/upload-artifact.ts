import * as core from '@actions/core'
import {findFilesToUpload} from './search'
import {getInputs} from './input-helper'
import {NoFileOptions} from './constants'
import { Octokit } from 'octokit'
import * as github from "@actions/github";
import { DefaultArtifactClient } from './artifact-client'

async function run(): Promise<void> {
  try {
    const github_token = core.getInput('GITHUB_TOKEN');
    const inputs = getInputs()
    const searchResult = await findFilesToUpload(inputs.searchPath)
    if (searchResult.filesToUpload.length === 0) {
      // No files were found, different use cases warrant different types of behavior if nothing is found
      switch (inputs.ifNoFilesFound) {
        case NoFileOptions.warn: {
          core.warning(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
        case NoFileOptions.error: {
          core.setFailed(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
        case NoFileOptions.ignore: {
          core.info(
            `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
          )
          break
        }
      }
    } else {
      const s = searchResult.filesToUpload.length === 1 ? '' : 's'
      core.info(
        `With the provided path, there will be ${searchResult.filesToUpload.length} file${s} uploaded`
      )
      core.debug(`Root artifact directory is ${searchResult.rootDirectory}`)

      if (searchResult.filesToUpload.length > 10000) {
        core.warning(
          `There are over 10,000 files in this artifact, consider creating an archive before upload to improve the upload performance.`
        )
      }

      const artifactClient = DefaultArtifactClient.create()

      const uploadResponse = await artifactClient.uploadArtifact(
        inputs.artifactName,
        searchResult.filesToUpload,
        searchResult.rootDirectory,
      )

      const url = uploadResponse.containerUrl
      const octokit = new Octokit({
        auth: github_token
      });

      const pull_request_number = github.context.payload.pull_request?.number;
      if (pull_request_number){
        await octokit.rest.issues.createComment({
         ...github.context.repo,
         issue_number: pull_request_number,
         body: `${url}`,
         
        })
      }

      if (uploadResponse.failedItems.length > 0) {
        core.setFailed(
          `An error was encountered when uploading ${uploadResponse.artifactName}. There were ${uploadResponse.failedItems.length} items that failed to upload.`
        )
      } else {
        core.info(
          `Artifact ${uploadResponse.artifactName} has been successfully uploaded!`
        )
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()
