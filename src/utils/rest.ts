/**
 * Utilities and abstraction for REST API access etc.
 * 
 */
import got, { OptionsOfTextResponseBody } from 'got'
import * as ds from './debugScopes'
const log = ds.getLog('rest')

/**
 * postWithRetry:  Wraps got library with setup for POST to perform retry on
 *                 default supported failures (see: https://github.com/sindresorhus/got#retry).
 * 
 * @param url 
 * @param payload 
 * 
 * TODO: Override calculateDelay in retry object to furnish prometheus metrics.
 */
export const postWithRetry = async(
  url: string, 
  payload: any,
  headers: any = { 'content-type': 'application/json' } ): Promise<any> => 
{
  try {
    const options: OptionsOfTextResponseBody = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      retry: { methods: ['POST'], limit: 3 }
    }

    return await got(url, options).json()
  } catch(error) {
    throw new Error(
      'Post failed:\n' +
      `  url: ${url}}\n` +
      `  payload: ${JSON.stringify(payload)}\n` +
      '  error:\n' + error)
  }
}