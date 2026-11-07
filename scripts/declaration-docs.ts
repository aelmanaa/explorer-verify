// Public declaration comments must not expose contributor tracking IDs (R-DX-4, #226).

/** Contributor references that do not belong in editor hover text. */
const INTERNAL_REFERENCE = /\b(?:R-[A-Z]+-\d+|decisions?\s+\d{4})\b/i;

/** Reports each declaration line that exposes an internal reference. */
export function declarationDocProblems(file: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      INTERNAL_REFERENCE.test(line)
        ? [`${file}:${String(index + 1)}: move contributor references to a source // comment`]
        : [],
    );
}
