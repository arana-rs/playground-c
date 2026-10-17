/** Errno codes exposed by the C locale and virtual-file profile. */
export const ERRNO_CODES = Object.freeze({
  ENOENT: 2,
  ENOMEM: 12,
  EBADF: 9,
  EBUSY: 16,
  EEXIST: 17,
  EINVAL: 22,
  ENOSYS: 38,
  EDOM: 33,
  ERANGE: 34,
  EILSEQ: 84,
  EIO: 5,
});

export const ERRNO_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Success',
  [ERRNO_CODES.ENOENT]: 'No such file or directory',
  [ERRNO_CODES.ENOMEM]: 'Cannot allocate memory',
  [ERRNO_CODES.EBADF]: 'Bad file descriptor',
  [ERRNO_CODES.EBUSY]: 'Device or resource busy',
  [ERRNO_CODES.EEXIST]: 'File exists',
  [ERRNO_CODES.EINVAL]: 'Invalid argument',
  [ERRNO_CODES.ENOSYS]: 'Function not implemented',
  [ERRNO_CODES.EDOM]: 'Numerical argument out of domain',
  [ERRNO_CODES.ERANGE]: 'Result out of range',
  [ERRNO_CODES.EILSEQ]: 'Illegal byte sequence',
  [ERRNO_CODES.EIO]: 'Input/output error',
});

export const ERRNO_MACROS: Readonly<Record<string, number>> = Object.freeze({
  EDOM: ERRNO_CODES.EDOM,
  EILSEQ: ERRNO_CODES.EILSEQ,
  ERANGE: ERRNO_CODES.ERANGE,
  ENOENT: ERRNO_CODES.ENOENT,
  ENOMEM: ERRNO_CODES.ENOMEM,
  EBADF: ERRNO_CODES.EBADF,
  EBUSY: ERRNO_CODES.EBUSY,
  EEXIST: ERRNO_CODES.EEXIST,
  EINVAL: ERRNO_CODES.EINVAL,
  ENOSYS: ERRNO_CODES.ENOSYS,
  EIO: ERRNO_CODES.EIO,
});
