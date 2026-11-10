// A work order's file name, in any language (Owner 2026-11-06). Compared and stored in one Unicode form:
// macOS's file systems hand names back decomposed, so one Chinese or Japanese file would otherwise be two
// work orders on two machines. NFC is the form Git settles on there too (core.precomposeunicode).
export const nfc = (text) => String(text).normalize("NFC");

// Letters, combining marks and digits of any script, . _ - and single spaces between words.
const NAME = /^[\p{L}\p{M}\p{N}._-]+(?: [\p{L}\p{M}\p{N}._-]+)*$/u;
// The name goes into file names beside other text (<name>.resume-<run id>.plan.json, a result's
// "<name> <date> <time> <conclusion>.md"), and one path component holds 255 bytes on Linux. Characters are
// the limit it always had, which keeps Windows' path length where it was; bytes are what a script of
// three bytes a character would otherwise overrun.
const MAX_CHARACTERS = 80;
const MAX_BYTES = 180;

// What is wrong with this as a work order's name, to follow the name in a sentence, or null.
export function workOrderNameProblem(name) {
  const text = nfc(name);
  if (/[\\/]/.test(text)) return "has a path separator in it";
  if (/^[. ]|[. ]$/.test(text)) return "starts or ends with a dot or a space";
  if (!NAME.test(text)) return "can only have letters, digits and marks of any language, dot, dash, underscore and single spaces";
  if (text.length > MAX_CHARACTERS || Buffer.byteLength(text, "utf8") > MAX_BYTES) return "is longer than " + MAX_CHARACTERS + " characters or " + MAX_BYTES + " bytes";
  return null;
}
