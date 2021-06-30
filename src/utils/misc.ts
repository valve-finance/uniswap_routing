export const padStr = (str: string, desiredWidth=25): string => {
  const numSpacesNeeded = desiredWidth - str.length
  for (let idx = 0; idx < numSpacesNeeded; idx++) {
    str += ' '
  }
  return str
}