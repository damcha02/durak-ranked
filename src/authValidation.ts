export const isUsername = (value: string) => /^[A-Za-z0-9_]{3,22}$/.test(value)
export const isEmailIdentifier = (value: string) => value.includes('@')
