/**
 * Abstraction area for persistence.
 * 
 * Methods to store an object along with the timestamp of when it was stored, retrieving likewise.
 * 
 * Object format:
 * {
 *   timeMs: <time object was stored in ms UTC>,
 *   object: <the stored object>
 * }
 * 
 * TODO:
 *    - Currently using local file storage. Future expansion to database and/or cloud storage.
 *    - Timestamping
 *    - Hashing - object ordering
 *    - Blocking / Singleton
 *    - Scheduled storage
 */
import {promises as fs} from 'fs'
import log from 'loglevel'

/**
 * 
 * @param key 
 * @param object 
 * @param formatted 
 */
export const storeObject = async (key: string, 
                                  object: any,
                                  formatted: boolean = true): Promise<void> =>
{
  let _objectStr = ''
  try {
    const _object = {
      timeMs: Date.now(),
      object
    }
   _objectStr =  formatted ? JSON.stringify(_object, null, 2) : JSON.stringify(_object)
  } catch (error) {
    throw new Error(`Unable to stringify object for storage.\n${error}`)
  }

  try {
    await fs.writeFile(key, _objectStr)
  } catch (error) {
    throw new Error(`Failed to store stringified object.\n${error}`)
  }
}

/**
 * 
 * @param key 
 * @returns 
 */
export const retrieveObject = async(key: string): Promise<any> =>
{
  if (!key) {
    throw new Error(`Specify a key to retrieve an object.`)
  }

  let stringifiedObjBuf: Buffer | undefined = undefined
  try {
    stringifiedObjBuf = await fs.readFile(key)
  } catch (error) {
    throw new Error(`Failed to retrieve stringified object at key ${key}\n${error}`)
  }

  if (!stringifiedObjBuf) {
    throw new Error(`Retrieved object is empty or undefined at key ${key}.`)
  }

  let _stringifiedObj = ''
  let _object: any = {}
  try {
    _stringifiedObj = stringifiedObjBuf.toString()
    _object = JSON.parse(_stringifiedObj)
  } catch (error) {
    throw new Error(`Unable to parse stringified object retrieved at key ${key}.\n` +
                    `Stringified object: ${_stringifiedObj.substr(0, 1024)}`)
  }

  if (!_object.hasOwnProperty('object') || !_object.hasOwnProperty('timeMs')) {
    throw new Error('Retreived object appears to be corrupt and is missing one or ' +
                    'more expected properties ("object", "timeMs")')
  }

  return _object
}