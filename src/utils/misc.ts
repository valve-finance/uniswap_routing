export const padStr = (str: string, desiredWidth=25): string => 
{
  const numSpacesNeeded = desiredWidth - str.length
  for (let idx = 0; idx < numSpacesNeeded; idx++) {
    str += ' '
  }
  return str
}

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
