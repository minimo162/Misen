export declare function isHex(char: string): boolean;
export declare function isDigit(char: string): boolean;
export declare function isValidStringCharacter(char: string): boolean;
export declare function isDelimiter(char: string): boolean;
export declare function isFunctionNameCharStart(char: string): boolean;
export declare function isFunctionNameChar(char: string): boolean;
export declare const regexUrlStart: RegExp;
export declare const regexUrlChar: RegExp;
export declare function isUnquotedStringDelimiter(char: string): boolean;
export declare function isStartOfValue(char: string): boolean;
export declare function isControlCharacter(char: string): char is "\n" | "\r" | "\t" | "\b" | "\f";
export interface Text {
    charCodeAt: (index: number) => number;
}
/**
 * Check if the given character is a whitespace character like space, tab, or
 * newline
 */
export declare function isWhitespace(text: Text, index: number): boolean;
/**
 * Check if the given character is a whitespace character like space or tab,
 * but NOT a newline
 */
export declare function isWhitespaceExceptNewline(text: Text, index: number): boolean;
/**
 * Check if the given character is a special whitespace character, some
 * unicode variant
 */
export declare function isSpecialWhitespace(text: Text, index: number): boolean;
/**
 * Test whether the given character is a quote or double quote character.
 * Also tests for special variants of quotes.
 */
export declare function isQuote(char: string): boolean;
/**
 * Test whether the given character is a double quote character.
 * Also tests for special variants of double quotes.
 */
export declare function isDoubleQuoteLike(char: string): boolean;
/**
 * Test whether the given character is a double quote character.
 * Does NOT test for special variants of double quotes.
 */
export declare function isDoubleQuote(char: string): boolean;
/**
 * Test whether the given character is a single quote character.
 * Also tests for special variants of single quotes.
 */
export declare function isSingleQuoteLike(char: string): boolean;
/**
 * Test whether the given character is a single quote character.
 * Does NOT test for special variants of single quotes.
 */
export declare function isSingleQuote(char: string): boolean;
/**
 * Strip last occurrence of textToStrip from text
 */
export declare function stripLastOccurrence(text: string, textToStrip: string, stripRemainingText?: boolean): string;
export declare function insertBeforeLastWhitespace(text: string, textToInsert: string): string;
export declare function removeAtIndex(text: string, start: number, count: number): string;
/**
 * Test whether a string ends with a newline or comma character and optional whitespace
 */
export declare function endsWithCommaOrNewline(text: string): boolean;
export declare const maxHtmlEntityLength = 12;
export interface HtmlEntityMatch {
    char: string;
    length: number;
}
/**
 * Try to match an HTML entity at the start of the given fragment. The fragment
 * is a small slice of text that begins exactly at the candidate '&'. Returns the
 * decoded character and the number of characters consumed, or null when there
 * is no complete, valid entity (for example a truncated "&quot" without ';').
 */
export declare function matchHtmlEntity(fragment: string): HtmlEntityMatch | null;
/**
 * Test whether a matched HTML entity decodes to a double quote character
 */
export declare function isDoubleQuoteEntity(match: HtmlEntityMatch | null): boolean;
/**
 * Test whether a matched HTML entity decodes to a single quote character
 */
export declare function isSingleQuoteEntity(match: HtmlEntityMatch | null): boolean;
/**
 * Count the number of occurrences of a single character in a string
 */
export declare function countOccurrences(text: string, char: string): number;
/**
 * Test whether `closeChar` is a closing bracket and `text` still contains an
 * unmatched opening bracket of the same kind. This indicates that the end of
 * `text` is located inside the brackets, for example the quote in
 * `"a (b") c"` is followed by `)` while `(` is still unclosed.
 *
 * Note that the (potentially expensive) counting is only performed when
 * `closeChar` actually is a closing bracket.
 */
export declare function isInsideUnclosedBracket(text: string, closeChar: string): boolean;
//# sourceMappingURL=stringUtils.d.ts.map