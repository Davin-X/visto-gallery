export function isWarningNotice(text: string): boolean {
  return /failed|could not|cannot access|not a folder|could not read|no media files found|no supported media/i.test(
    text,
  );
}
