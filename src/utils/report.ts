import * as cr from 'crypto'
import * as fs from 'fs'
import log from 'loglevel'
import { report } from 'process'



export const REPORTS_DIR = 'reports'
export const PARAMS_FILE = 'params.json'
export const REPORT_FILE_NAME = 'report.json'

export const getReportParametersHash = (reportParameters: any): string =>
{
  const orderedKeys: any = Object.keys(reportParameters).sort()
  const orderedKeyValues = []
  for (const key of orderedKeys) {
    orderedKeyValues.push(`${key}::${reportParameters[key]}`)
  }
  
  const hash = cr.createHash('md5')   // md5 should be sufficient here as the application is not security
                                      // and sha256's length can be problematic for win fs's.
  hash.update(orderedKeyValues.join('-'))
  const hashStr = hash.digest('hex')

  return hashStr
}


export const loadReportSummaries = async(): Promise<any> =>
{
  const path = [ REPORTS_DIR ]

  // Start by reading all the sub-directories in the reports directory:
  //
  let reportSubdirs: any = []
  try {
    let reportsPath = path.join('/')
    reportSubdirs = await new Promise((resolve, reject) => {
      fs.readdir(reportsPath, (err, files) => {
        if (err) {
          reject(`Failed to load report summaries because:\n${err}`)
        } else {
          resolve(files)
        }
      })
    })
  } catch (error) {
    log.warn(error)
    return []
  }

  // Now read each param file in the sub-directories that were found and
  // construct summary objects that include the sub-directory name:
  //
  const paramReadfilePromises: any = []
  for (const subdir of reportSubdirs) {
    path.push(subdir)
    path.push(PARAMS_FILE)

    const paramFilepath = path.join('/')
    paramReadfilePromises.push(
      new Promise((resolve) => {
        fs.readFile(paramFilepath, (err, data) => {
          if (err) {
            resolve({ failed: paramFilepath, err })
          } else {
            try {
              resolve({reportSubdir: subdir, params: JSON.parse(data.toString()) })
            } catch (parseErr) {
              resolve({ failed: paramFilepath, err: parseErr })
            }
          }
        })
      })
    )

    path.pop()
    path.pop()
  }

  const reportSummaries: any = []
  const paramFileResults: any = await Promise.all(paramReadfilePromises)
  for (const result of paramFileResults) {
    if (result && result.failed ) {
      log.warn(`Failed to read param file ${result.failed} because ${result.err}`)
    } else {
      reportSummaries.push(result)
    }
  }

  return reportSummaries
}

export const reportSummariesToOptions= (reportMetadata: any) => 
{
  const MAX_DESC_WIDTH = 100
  const existingAnalysisOptions: any = []

  for (const metadata of reportMetadata) {
    const { reportSubdir, params } = metadata

    const fmtdAmt = new Intl.NumberFormat('us-US', 
                                          { style: 'currency', currency: 'USD' }).format(params.tradeAmount)
    let text = params.analysisDescription ?
               params.analysisDescription :
               `Trade ${fmtdAmt} in ${params.tokenSet}.`
    if (text.length > MAX_DESC_WIDTH) {
      text = text.substr(0, MAX_DESC_WIDTH) + ' ...'
    }

    const contentRows: any = [{
      formatting: 'title',
      descriptor: '',
      value: text
    }]

    contentRows.push({
      formatting: 'sub-title',
      descriptor: '',
      value: `Block #${params.blockNumber}, Report ID ${reportSubdir}`
    })

    if (params.analysisDescription) {
      contentRows.push({
        formatting: 'description',
        descriptor: 'Description',
        value: params.analysisDescription
      })
    }

    for (const param in params) {
      if (param !== 'analysisDescription') {
        contentRows.push({
          formatting: 'parameter',
          descriptor: param,
          value: params[param]
        })
      }
    }

    existingAnalysisOptions.push({
      key: reportSubdir,
      text, 
      value: reportSubdir,
      contentRows
    })
  }

  return existingAnalysisOptions
}