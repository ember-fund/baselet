import { Disklet } from 'disklet'

import {
  checkAndformatPartition,
  checkDatabaseName,
  doesDatabaseExist,
  isPositiveInteger
} from './helpers'
import { BaseletConfig, BaseType } from './types'

export interface HashBase {
  insert(partition: string, hash: string, data: any): Promise<unknown>
  query(partition: string, hashes: string[]): Promise<any[]>
}

interface HashBaseConfig extends BaseletConfig {
  prefixSize: number
}

interface BucketDictionary {
  [bucketName: string]: {
    bucketFetcher: Promise<void>
    bucketData: {
      [hash: string]: any
    }
  }
}

export function openHashBase(
  disklet: Disklet,
  databaseName: string
): Promise<HashBase> {
  function getConfig(): Promise<HashBaseConfig> {
    return disklet.getText(`${databaseName}/config.json`).then(
      serializedConfig => JSON.parse(serializedConfig),
      error => {
        console.log(error)
        throw new Error(
          `The disklet does not have a valid database ${databaseName}`
        )
      }
    )
  }

  return getConfig().then(configData => {
    if (configData.type !== BaseType.HashBase) {
      throw new Error(`Tried to open HashBase, but type is ${configData.type}`)
    }

    return {
      insert(partition: string, hash: string, data: any): Promise<unknown> {
        const { prefixSize } = configData
        const formattedPartition = checkAndformatPartition(partition)
        if (typeof hash !== 'string' || hash.length < prefixSize) {
          return Promise.reject(
            new Error(`hash must be a string of length at least ${prefixSize}`)
          )
        }

        const prefix = hash.substring(0, prefixSize)
        const bucketFilename = `${prefix}.json`
        const bucketPath = `${databaseName}${formattedPartition}/${bucketFilename}`
        return disklet.getText(bucketPath).then(
          serializedBucket => {
            const bucketData = JSON.parse(serializedBucket)
            bucketData[hash] = data
            return disklet.setText(bucketPath, JSON.stringify(bucketData))
          },
          () => {
            // assuming bucket doesnt exist
            return disklet.setText(bucketPath, JSON.stringify({ [hash]: data }))
          }
        )
      },
      query(partition: string, hashes: string[]): Promise<any[]> {
        const formattedPartition = checkAndformatPartition(partition)
        if (hashes.length < 1) {
          return Promise.reject(
            new Error('At least one hash is required to query database.')
          )
        }
        const { prefixSize } = configData
        const bucketFetchers = []
        const bucketDict: BucketDictionary = {}
        for (let inputIndex = 0; inputIndex < hashes.length; inputIndex++) {
          // TODO: check to make sure hash length is at least prefixSize
          const bucketName: keyof typeof bucketDict = hashes[
            inputIndex
          ].substring(0, prefixSize)
          if (bucketDict[bucketName] === undefined) {
            const bucketFetcher = disklet
              .getText(
                `${databaseName}${formattedPartition}/${bucketName}.json`
              )
              .then(
                serializedBucket => {
                  bucketDict[bucketName].bucketData = JSON.parse(
                    serializedBucket
                  )
                },
                () => {
                  // assume bucket doesn't exist
                }
              )
            bucketDict[bucketName] = {
              bucketFetcher,
              bucketData: {}
            }
            bucketFetchers.push(bucketFetcher)
          }
        }
        return Promise.all(bucketFetchers).then(() => {
          const results = []
          for (let inputIndex = 0; inputIndex < hashes.length; inputIndex++) {
            const bucketName = hashes[inputIndex].substring(0, prefixSize)
            const bucketData = bucketDict[bucketName].bucketData
            const hashData = bucketData[hashes[inputIndex]]
            results.push(hashData)
          }
          return results
        })
      }
    }
  })
}

export function createHashBase(
  disklet: Disklet,
  databaseName: string,
  prefixSize: number
): Promise<HashBase> {
  databaseName = checkDatabaseName(databaseName)
  if (!isPositiveInteger(prefixSize)) {
    throw new Error(`prefixSize must be a number greater than 0`)
  }

  const configData: HashBaseConfig = {
    type: BaseType.HashBase,
    prefixSize
  }
  return doesDatabaseExist(disklet, databaseName).then(databaseExists => {
    if (databaseExists) {
      throw new Error(`database ${databaseName} already exists`)
    }
    return disklet
      .setText(`${databaseName}/config.json`, JSON.stringify(configData))
      .then(() => openHashBase(disklet, databaseName))
  })
}
