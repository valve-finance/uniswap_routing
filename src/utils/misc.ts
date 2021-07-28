/********************************************************************************
 * Misc
 ********************************************************************************/ 
export const deepCopy = (anObj: any): any => {
  return JSON.parse(JSON.stringify(anObj))
}

/********************************************************************************
 * String formatting
 ********************************************************************************/ 

export const padStr = (str: string, desiredWidth=25): string => 
{
  const numSpacesNeeded = desiredWidth - str.length
  for (let idx = 0; idx < numSpacesNeeded; idx++) {
    str += ' '
  }
  return str
}

export const getSpaces = (numSpaces: number = 0): string => 
{
  let spaceStr = ''
  for (let spaceCnt = 0; spaceCnt < numSpaces; spaceCnt++) {
    spaceStr += ' '
  }
  return spaceStr
}



/********************************************************************************
 * REST sanitization/error methods
 ********************************************************************************/ 

export const sanitizeProperty = (name: string, value: any, type='string'): string => 
{
  if (value === undefined || value === null || typeof value !== type) {
    return `Property "${name}" is not defined or is not a ${type}.\n`
  }

  return ''
}

export const sanitizePropertyType = (name: string, value: any, type='string'): string => 
{
  if (typeof value !== type) {
    return `Property "${name}" is not a ${type}.\n`
  }

  return ''
}


/********************************************************************************
 * Numeric Methods for Bigint/TokenAmount 
 ********************************************************************************/ 

const zeroString = (numZeros: number):string =>
{
  let _zeroStr = ''
  for (let i = numZeros; i > 0; i--) {
    _zeroStr += '0'
  }
  return _zeroStr
}

/**
 * Removes a decimal place if found and pads out to the correct
 * number of zeros.
 *
 * If no decimal found, adds appropriate number of zeros to make the
 * decimal place happen.
 * 
 * e.g.:  value=1.35, decimals=5, returns:  135000
 *        value=121, decimals=3, returns: 121000
 *  
 * @param value 
 * @param decimals 
 * 
 */
export const getIntegerString = (value: string, decimals: number):string =>
{
  const _value = value.trim()
  const pointIdx = _value.indexOf('.')
  const fractionalDigits = _value.length - (pointIdx + 1)

  // Three cases to handle:
  //
  if (pointIdx < 0) {
    //   1. No decimal point, so pad the specified number of decimals and return.
    //
    return _value + zeroString(decimals)
  } else if (fractionalDigits > decimals) {
    //   2. Decimal point at position where fractional digits exceeds specified 
    //      decimals. In this case truncate extra digits and remove decimal point.
    //
    const trimDigits = fractionalDigits - decimals
    return _value.substr(0, _value.length - trimDigits).replace('.', '')
  } else {
    //   3. Decimal point at position where same or fewer fractional digits than specified
    //      decimals. In this case pad extra zeros after removing decimal point.
    //
    const addDigits = decimals - fractionalDigits
    return _value.replace('.', '') + zeroString(addDigits)
  }
}
