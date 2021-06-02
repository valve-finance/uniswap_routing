// TODO: normalize might be the wrong word here since these methods largely convert floating
//       point values to integer representations scaled a number of decimal places.
//

export const zeroString = (numZeros: number):string =>
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
 * TODO: tons of corner cases to handle:
 *        -  .23
 *        -  more frac digits than decimals
 * 
 */
export const getNormalizedValue = (value: string, decimals: number):string =>
{
  const pointIdx = value.indexOf('.')
  if (pointIdx < 0) {
    // No point ('.')
    return value + zeroString(decimals)
  } else {
    const fracDigits = value.length - (pointIdx + 1)
    const padDigits = decimals - fracDigits
    if (padDigits < 0) {
      throw new Error(`Too many decimal places in value ${value} for expected decimal places (${decimals})`)
    }

    return value.replace('.', '') + padDigits
  }
}

/**
 * getNormalizedIntReserves:
 *   Converts the floating point numbers reserve0 and reserve1 to integer 
 *   representations with aligned least signfificant digits (padded with zero
 *   LSDs if required).
 * 
 * @param reserve0 A string representing a floating point number. (i.e. '100.23')
 * @param reserve1 A string representing a floating point number. (i.e. '1000.234')
 * 
 * TODO: handle situation where no point ('.')
 */
export const getNormalizedIntReserves = (reserve0: string, reserve1: string): any =>
{
  const _res0FracDigits = reserve0.length - (reserve0.indexOf('.') + 1)
  const _res1FracDigits = reserve1.length - (reserve1.indexOf('.') + 1)

  if (_res0FracDigits === _res1FracDigits) {
    return {
      normReserve0: reserve0.replace('.', ''),
      normReserve1: reserve1.replace('.', '')
    }
  } else if (_res0FracDigits > _res1FracDigits) {
    const _padDigits = _res0FracDigits - _res1FracDigits
    return {
      normReserve0: reserve0.replace('.', ''),
      normReserve1: reserve1.replace('.', '') + zeroString(_padDigits)
    }
  } else {
    const _padDigits = _res1FracDigits - _res0FracDigits 
    return {
      normReserve0: reserve0.replace('.', '') + zeroString(_padDigits),
      normReserve1: reserve1.replace('.', '')
    }
  }
}

