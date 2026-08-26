"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// vendor/npm/node_modules/jsonrepair/lib/cjs/utils/JSONRepairError.js
var require_JSONRepairError = __commonJS({
  "vendor/npm/node_modules/jsonrepair/lib/cjs/utils/JSONRepairError.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", {
      value: true
    });
    exports2.JSONRepairError = void 0;
    var JSONRepairError = class extends Error {
      constructor(message, position) {
        super(`${message} at position ${position}`);
        this.position = position;
      }
    };
    exports2.JSONRepairError = JSONRepairError;
  }
});

// vendor/npm/node_modules/jsonrepair/lib/cjs/utils/stringUtils.js
var require_stringUtils = __commonJS({
  "vendor/npm/node_modules/jsonrepair/lib/cjs/utils/stringUtils.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", {
      value: true
    });
    exports2.countOccurrences = countOccurrences;
    exports2.endsWithCommaOrNewline = endsWithCommaOrNewline;
    exports2.insertBeforeLastWhitespace = insertBeforeLastWhitespace;
    exports2.isControlCharacter = isControlCharacter;
    exports2.isDelimiter = isDelimiter;
    exports2.isDigit = isDigit;
    exports2.isDoubleQuote = isDoubleQuote;
    exports2.isDoubleQuoteEntity = isDoubleQuoteEntity;
    exports2.isDoubleQuoteLike = isDoubleQuoteLike;
    exports2.isFunctionNameChar = isFunctionNameChar;
    exports2.isFunctionNameCharStart = isFunctionNameCharStart;
    exports2.isHex = isHex;
    exports2.isInsideUnclosedBracket = isInsideUnclosedBracket;
    exports2.isQuote = isQuote;
    exports2.isSingleQuote = isSingleQuote;
    exports2.isSingleQuoteEntity = isSingleQuoteEntity;
    exports2.isSingleQuoteLike = isSingleQuoteLike;
    exports2.isSpecialWhitespace = isSpecialWhitespace;
    exports2.isStartOfValue = isStartOfValue;
    exports2.isUnquotedStringDelimiter = isUnquotedStringDelimiter;
    exports2.isValidStringCharacter = isValidStringCharacter;
    exports2.isWhitespace = isWhitespace;
    exports2.isWhitespaceExceptNewline = isWhitespaceExceptNewline;
    exports2.matchHtmlEntity = matchHtmlEntity;
    exports2.regexUrlStart = exports2.regexUrlChar = exports2.maxHtmlEntityLength = void 0;
    exports2.removeAtIndex = removeAtIndex;
    exports2.stripLastOccurrence = stripLastOccurrence;
    var codeSpace = 32;
    var codeNewline = 10;
    var codeTab = 9;
    var codeReturn = 13;
    var codeNonBreakingSpace = 160;
    var codeMongolianVowelSeparator = 6158;
    var codeEnQuad = 8192;
    var codeZeroWidthSpace = 8203;
    var codeNarrowNoBreakSpace = 8239;
    var codeMediumMathematicalSpace = 8287;
    var codeIdeographicSpace = 12288;
    var codeZeroWidthNoBreakSpace = 65279;
    function isHex(char) {
      return /^[0-9A-Fa-f]$/.test(char);
    }
    function isDigit(char) {
      return char >= "0" && char <= "9";
    }
    function isValidStringCharacter(char) {
      return char >= " ";
    }
    function isDelimiter(char) {
      return ",:[]/{}()\n+".includes(char);
    }
    function isFunctionNameCharStart(char) {
      return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$";
    }
    function isFunctionNameChar(char) {
      return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$" || char >= "0" && char <= "9";
    }
    var regexUrlStart = exports2.regexUrlStart = /^(http|https|ftp|mailto|file|data|irc):\/\/$/;
    var regexUrlChar = exports2.regexUrlChar = /^[A-Za-z0-9-._~:/?#@!$&'()*+;=]$/;
    function isUnquotedStringDelimiter(char) {
      return ",[]/{}\n+".includes(char);
    }
    function isStartOfValue(char) {
      return isQuote(char) || regexStartOfValue.test(char);
    }
    var regexStartOfValue = /^[[{\w-]$/;
    function isControlCharacter(char) {
      return char === "\n" || char === "\r" || char === "	" || char === "\b" || char === "\f";
    }
    function isWhitespace(text, index) {
      const code = text.charCodeAt(index);
      return code === codeSpace || code === codeNewline || code === codeTab || code === codeReturn;
    }
    function isWhitespaceExceptNewline(text, index) {
      const code = text.charCodeAt(index);
      return code === codeSpace || code === codeTab || code === codeReturn;
    }
    function isSpecialWhitespace(text, index) {
      const code = text.charCodeAt(index);
      return code === codeNonBreakingSpace || code === codeMongolianVowelSeparator || code >= codeEnQuad && code <= codeZeroWidthSpace || code === codeNarrowNoBreakSpace || code === codeMediumMathematicalSpace || code === codeIdeographicSpace || code === codeZeroWidthNoBreakSpace;
    }
    function isQuote(char) {
      return isDoubleQuoteLike(char) || isSingleQuoteLike(char);
    }
    function isDoubleQuoteLike(char) {
      return char === '"' || char === "\u201C" || char === "\u201D";
    }
    function isDoubleQuote(char) {
      return char === '"';
    }
    function isSingleQuoteLike(char) {
      return char === "'" || char === "\u2018" || char === "\u2019" || char === "`" || char === "\xB4";
    }
    function isSingleQuote(char) {
      return char === "'";
    }
    function stripLastOccurrence(text, textToStrip) {
      let stripRemainingText = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : false;
      const index = text.lastIndexOf(textToStrip);
      return index !== -1 ? text.substring(0, index) + (stripRemainingText ? "" : text.substring(index + 1)) : text;
    }
    function insertBeforeLastWhitespace(text, textToInsert) {
      let index = text.length;
      if (!isWhitespace(text, index - 1)) {
        return text + textToInsert;
      }
      while (isWhitespace(text, index - 1)) {
        index--;
      }
      return text.substring(0, index) + textToInsert + text.substring(index);
    }
    function removeAtIndex(text, start, count) {
      return text.substring(0, start) + text.substring(start + count);
    }
    function endsWithCommaOrNewline(text) {
      return /[,\n][ \t\r]*$/.test(text);
    }
    var namedHtmlEntities = {
      "&quot;": '"',
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&apos;": "'"
    };
    var maxHtmlEntityLength = exports2.maxHtmlEntityLength = 12;
    function matchHtmlEntity(fragment) {
      if (fragment.charAt(0) !== "&") {
        return null;
      }
      const semicolon = fragment.indexOf(";");
      if (semicolon === -1) {
        return null;
      }
      const entity = fragment.substring(0, semicolon + 1);
      const named = namedHtmlEntities[entity];
      if (named !== void 0) {
        return {
          char: named,
          length: entity.length
        };
      }
      if (fragment.charAt(1) === "#") {
        const body = fragment.substring(2, semicolon);
        const hex = body.charAt(0) === "x" || body.charAt(0) === "X";
        const digits = hex ? body.substring(1) : body;
        if (digits.length > 0) {
          const code = Number.parseInt(digits, hex ? 16 : 10);
          if (!Number.isNaN(code) && code >= 0 && code <= 1114111) {
            return {
              char: String.fromCodePoint(code),
              length: entity.length
            };
          }
        }
      }
      return null;
    }
    function isDoubleQuoteEntity(match) {
      return match !== null && match.char === '"';
    }
    function isSingleQuoteEntity(match) {
      return match !== null && match.char === "'";
    }
    function countOccurrences(text, char) {
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charAt(i) === char) {
          count++;
        }
      }
      return count;
    }
    function isInsideUnclosedBracket(text, closeChar) {
      switch (closeChar) {
        case ")":
          return countOccurrences(text, "(") > countOccurrences(text, ")");
        case "]":
          return countOccurrences(text, "[") > countOccurrences(text, "]");
        case "}":
          return countOccurrences(text, "{") > countOccurrences(text, "}");
        default:
          return false;
      }
    }
  }
});

// vendor/npm/node_modules/jsonrepair/lib/cjs/regular/jsonrepair.js
var require_jsonrepair = __commonJS({
  "vendor/npm/node_modules/jsonrepair/lib/cjs/regular/jsonrepair.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", {
      value: true
    });
    exports2.jsonrepair = jsonrepair2;
    var _JSONRepairError = require_JSONRepairError();
    var _stringUtils = require_stringUtils();
    var controlCharacters = {
      "\b": "\\b",
      "\f": "\\f",
      "\n": "\\n",
      "\r": "\\r",
      "	": "\\t"
    };
    var escapeCharacters = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "	"
      // note that \u is handled separately in parseString()
    };
    function jsonrepair2(text) {
      let i = 0;
      let output = "";
      parseMarkdownCodeBlock(["```", "[```", "{```"]);
      const processed = parseValue();
      if (!processed) {
        throwUnexpectedEnd();
      }
      parseMarkdownCodeBlock(["```", "```]", "```}"]);
      const processedComma = parseCharacter(",");
      if (processedComma) {
        parseWhitespaceAndSkipComments();
      }
      if ((0, _stringUtils.isStartOfValue)(text[i]) && (0, _stringUtils.endsWithCommaOrNewline)(output)) {
        if (!processedComma) {
          output = (0, _stringUtils.insertBeforeLastWhitespace)(output, ",");
        }
        parseNewlineDelimitedJSON();
      } else if (processedComma) {
        output = (0, _stringUtils.stripLastOccurrence)(output, ",");
      }
      while (text[i] === "}" || text[i] === "]") {
        i++;
        parseWhitespaceAndSkipComments();
      }
      if (i >= text.length) {
        return output;
      }
      throwUnexpectedCharacter();
      function parseValue() {
        parseWhitespaceAndSkipComments();
        const processed2 = parseObject() || parseArray() || parseString() || parseNumber() || parseKeywords() || parseUnquotedString(false) || parseRegex();
        parseWhitespaceAndSkipComments();
        return processed2;
      }
      function parseWhitespaceAndSkipComments() {
        let skipNewline = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : true;
        const start = i;
        let changed = parseWhitespace(skipNewline);
        do {
          changed = parseComment();
          if (changed) {
            changed = parseWhitespace(skipNewline);
          }
        } while (changed);
        return i > start;
      }
      function parseWhitespace(skipNewline) {
        const _isWhiteSpace = skipNewline ? _stringUtils.isWhitespace : _stringUtils.isWhitespaceExceptNewline;
        let whitespace = "";
        while (true) {
          if (_isWhiteSpace(text, i)) {
            whitespace += text[i];
            i++;
          } else if ((0, _stringUtils.isSpecialWhitespace)(text, i)) {
            whitespace += " ";
            i++;
          } else {
            break;
          }
        }
        if (whitespace.length > 0) {
          output += whitespace;
          return true;
        }
        return false;
      }
      function parseComment() {
        if (text[i] === "/" && text[i + 1] === "*") {
          while (i < text.length && !atEndOfBlockComment(text, i)) {
            i++;
          }
          i += 2;
          return true;
        }
        if (text[i] === "/" && text[i + 1] === "/") {
          while (i < text.length && text[i] !== "\n") {
            i++;
          }
          return true;
        }
        return false;
      }
      function parseMarkdownCodeBlock(blocks) {
        if (skipMarkdownCodeBlock(blocks)) {
          if ((0, _stringUtils.isFunctionNameCharStart)(text[i])) {
            while (i < text.length && (0, _stringUtils.isFunctionNameChar)(text[i])) {
              i++;
            }
          }
          parseWhitespaceAndSkipComments();
          return true;
        }
        return false;
      }
      function skipMarkdownCodeBlock(blocks) {
        parseWhitespace(true);
        for (const block of blocks) {
          const end = i + block.length;
          if (text.slice(i, end) === block) {
            i = end;
            return true;
          }
        }
        return false;
      }
      function parseCharacter(char) {
        if (text[i] === char) {
          output += text[i];
          i++;
          return true;
        }
        return false;
      }
      function skipCharacter(char) {
        if (text[i] === char) {
          i++;
          return true;
        }
        return false;
      }
      function skipEscapeCharacter() {
        return skipCharacter("\\");
      }
      function skipEllipsis() {
        parseWhitespaceAndSkipComments();
        if (text[i] === "." && text[i + 1] === "." && text[i + 2] === ".") {
          i += 3;
          parseWhitespaceAndSkipComments();
          skipCharacter(",");
          return true;
        }
        return false;
      }
      function parseObject() {
        if (text[i] === "{") {
          output += "{";
          i++;
          parseWhitespaceAndSkipComments();
          if (skipCharacter(",")) {
            parseWhitespaceAndSkipComments();
          }
          let initial = true;
          while (i < text.length && text[i] !== "}") {
            let processedComma2;
            if (!initial) {
              processedComma2 = parseCharacter(",");
              if (!processedComma2) {
                output = (0, _stringUtils.insertBeforeLastWhitespace)(output, ",");
              }
              parseWhitespaceAndSkipComments();
            } else {
              processedComma2 = true;
            }
            skipEllipsis();
            const processedKey = parseString() || parseUnquotedString(true);
            if (!processedKey) {
              if (text[i] === "}" || text[i] === "{" || text[i] === "]" || text[i] === "[" || text[i] === void 0) {
                if (!initial) {
                  output = (0, _stringUtils.stripLastOccurrence)(output, ",");
                }
              } else {
                throwObjectKeyExpected();
              }
              break;
            }
            parseWhitespaceAndSkipComments();
            const processedColon = parseCharacter(":");
            const truncatedText = i >= text.length;
            if (!processedColon) {
              if ((0, _stringUtils.isStartOfValue)(text[i]) || truncatedText) {
                output = (0, _stringUtils.insertBeforeLastWhitespace)(output, ":");
              } else {
                throwColonExpected();
              }
            }
            const processedValue = parseValue();
            if (!processedValue) {
              if (processedColon || truncatedText) {
                output += "null";
              } else {
                throwColonExpected();
              }
            }
            initial = false;
          }
          if (text[i] === "}") {
            output += "}";
            i++;
          } else {
            output = (0, _stringUtils.insertBeforeLastWhitespace)(output, "}");
          }
          return true;
        }
        return false;
      }
      function parseArray() {
        if (text[i] === "[") {
          output += "[";
          i++;
          parseWhitespaceAndSkipComments();
          if (skipCharacter(",")) {
            parseWhitespaceAndSkipComments();
          }
          let initial = true;
          while (i < text.length && text[i] !== "]") {
            if (!initial) {
              const processedComma2 = parseCharacter(",");
              if (!processedComma2) {
                output = (0, _stringUtils.insertBeforeLastWhitespace)(output, ",");
              }
            }
            skipEllipsis();
            const processedValue = parseValue();
            if (!processedValue) {
              if (!initial) {
                output = (0, _stringUtils.stripLastOccurrence)(output, ",");
              }
              break;
            }
            initial = false;
          }
          if (text[i] === "]") {
            output += "]";
            i++;
          } else {
            output = (0, _stringUtils.insertBeforeLastWhitespace)(output, "]");
          }
          return true;
        }
        return false;
      }
      function parseNewlineDelimitedJSON() {
        let initial = true;
        let processedValue = true;
        while (processedValue) {
          if (!initial) {
            const processedComma2 = parseCharacter(",");
            if (!processedComma2) {
              output = (0, _stringUtils.insertBeforeLastWhitespace)(output, ",");
            }
          } else {
            initial = false;
          }
          processedValue = parseValue();
        }
        if (!processedValue) {
          output = (0, _stringUtils.stripLastOccurrence)(output, ",");
        }
        output = `[
${output}
]`;
      }
      function parseString() {
        let stopAtDelimiter = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : false;
        let stopAtIndex = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : -1;
        const skipEscapeChars = text[i] === "\\";
        if (skipEscapeChars) {
          i++;
          if (!(0, _stringUtils.isQuote)(text[i])) {
            throwUnexpectedCharacter();
          }
        }
        const openEntity = text[i] === "&" ? (0, _stringUtils.matchHtmlEntity)(text.slice(i, i + _stringUtils.maxHtmlEntityLength)) : null;
        const openedByEntity = (0, _stringUtils.isDoubleQuoteEntity)(openEntity) || (0, _stringUtils.isSingleQuoteEntity)(openEntity);
        if ((0, _stringUtils.isQuote)(text[i]) || openedByEntity) {
          const isEndQuote = (0, _stringUtils.isDoubleQuote)(text[i]) ? _stringUtils.isDoubleQuote : (0, _stringUtils.isSingleQuote)(text[i]) ? _stringUtils.isSingleQuote : (0, _stringUtils.isSingleQuoteLike)(text[i]) ? _stringUtils.isSingleQuoteLike : _stringUtils.isDoubleQuoteLike;
          const iBefore = i;
          const oBefore = output.length;
          let str = '"';
          i += openedByEntity && openEntity ? openEntity.length : 1;
          while (true) {
            if (i >= text.length) {
              const iPrev = prevNonWhitespaceIndex(i - 1);
              if (!stopAtDelimiter && (0, _stringUtils.isDelimiter)(text.charAt(iPrev))) {
                i = iBefore;
                output = output.substring(0, oBefore);
                return parseString(true);
              }
              str = (0, _stringUtils.insertBeforeLastWhitespace)(str, '"');
              output += str;
              return true;
            }
            if (i === stopAtIndex) {
              str = (0, _stringUtils.insertBeforeLastWhitespace)(str, '"');
              output += str;
              return true;
            }
            const entity = openedByEntity && text[i] === "&" ? (0, _stringUtils.matchHtmlEntity)(text.slice(i, i + _stringUtils.maxHtmlEntityLength)) : null;
            const isEnd = entity && openEntity ? entity.char === openEntity.char : isEndQuote(text[i]);
            if (isEnd) {
              const iQuote = i;
              const oQuote = str.length;
              str += '"';
              i += entity ? entity.length : 1;
              output += str;
              parseWhitespaceAndSkipComments(false);
              if (stopAtDelimiter || i >= text.length || (0, _stringUtils.isDelimiter)(text[i]) && // only count the brackets inside the string when actually needed,
              // i.e. when the quote is directly followed by a closing bracket
              !(0, _stringUtils.isInsideUnclosedBracket)(str, text[i]) || (0, _stringUtils.isQuote)(text[i]) && !nextQuoteIsEndQuote(i) || (0, _stringUtils.isDigit)(text[i])) {
                parseConcatenatedString();
                return true;
              }
              if (text[i] === "\\") {
                throwUnexpectedCharacter();
              }
              const iPrevChar = prevNonWhitespaceIndex(iQuote - 1);
              const prevChar = text.charAt(iPrevChar);
              if (prevChar === ",") {
                i = iBefore;
                output = output.substring(0, oBefore);
                return parseString(false, iPrevChar);
              }
              if ((0, _stringUtils.isDelimiter)(prevChar)) {
                i = iBefore;
                output = output.substring(0, oBefore);
                return parseString(true);
              }
              output = output.substring(0, oBefore);
              i = iQuote + (entity ? entity.length : 1);
              str = `${str.substring(0, oQuote)}\\${str.substring(oQuote)}`;
            } else if (stopAtDelimiter && (0, _stringUtils.isUnquotedStringDelimiter)(text[i])) {
              if (text[i - 1] === ":" && _stringUtils.regexUrlStart.test(text.substring(iBefore + 1, i + 2))) {
                while (i < text.length && _stringUtils.regexUrlChar.test(text[i])) {
                  str += text[i];
                  i++;
                }
              }
              str = (0, _stringUtils.insertBeforeLastWhitespace)(str, '"');
              output += str;
              parseConcatenatedString();
              return true;
            } else if (entity) {
              const char = entity.char;
              if (char === '"') {
                str += '\\"';
              } else if ((0, _stringUtils.isControlCharacter)(char)) {
                str += controlCharacters[char];
              } else {
                str += char;
              }
              i += entity.length;
            } else if (text[i] === "\\") {
              const char = text.charAt(i + 1);
              const escapeChar = escapeCharacters[char];
              if (escapeChar !== void 0) {
                str += text.slice(i, i + 2);
                i += 2;
              } else if (char === "u") {
                let j = 2;
                while (j < 6 && (0, _stringUtils.isHex)(text[i + j])) {
                  j++;
                }
                if (j === 6) {
                  str += text.slice(i, i + 6);
                  i += 6;
                } else if (i + j >= text.length) {
                  i = text.length;
                } else {
                  throwInvalidUnicodeCharacter();
                }
              } else if (char === "\n") {
                str += "\\n";
                i += 2;
              } else {
                str += char;
                i += 2;
              }
            } else {
              const char = text.charAt(i);
              if (char === '"' && text[i - 1] !== "\\") {
                str += `\\${char}`;
                i++;
              } else if ((0, _stringUtils.isControlCharacter)(char)) {
                str += controlCharacters[char];
                i++;
              } else {
                if (!(0, _stringUtils.isValidStringCharacter)(char)) {
                  throwInvalidCharacter(char);
                }
                str += char;
                i++;
              }
            }
            if (skipEscapeChars) {
              skipEscapeCharacter();
            }
          }
        }
        return false;
      }
      function parseConcatenatedString() {
        let processed2 = false;
        parseWhitespaceAndSkipComments();
        while (text[i] === "+") {
          processed2 = true;
          i++;
          parseWhitespaceAndSkipComments();
          output = (0, _stringUtils.stripLastOccurrence)(output, '"', true);
          const start = output.length;
          const parsedStr = parseString();
          if (parsedStr) {
            output = (0, _stringUtils.removeAtIndex)(output, start, 1);
          } else {
            output = (0, _stringUtils.insertBeforeLastWhitespace)(output, '"');
          }
        }
        return processed2;
      }
      function parseNumber() {
        const start = i;
        let num = "";
        let invalid = false;
        if (text[i] === "-") {
          num += text[i];
          i++;
          if (!(0, _stringUtils.isDigit)(text[i]) && atEndOfNumber()) {
            num += "0";
          }
        }
        if (text[i] === "0" && (0, _stringUtils.isDigit)(text[i + 1])) {
          invalid = true;
        }
        while ((0, _stringUtils.isDigit)(text[i])) {
          num += text[i];
          i++;
        }
        if (text[i] === ".") {
          if (num === "" || num === "-") {
            num += "0";
          }
          num += text[i];
          i++;
          if (!(0, _stringUtils.isDigit)(text[i])) {
            num += "0";
          }
          while ((0, _stringUtils.isDigit)(text[i])) {
            num += text[i];
            i++;
          }
        }
        if (i > start) {
          if (text[i] === "e" || text[i] === "E") {
            if (num === "-") {
              invalid = true;
            }
            num += text[i];
            i++;
            if (text[i] === "-" || text[i] === "+") {
              num += text[i];
              i++;
            }
            if (!(0, _stringUtils.isDigit)(text[i])) {
              num += "0";
            }
            while ((0, _stringUtils.isDigit)(text[i])) {
              num += text[i];
              i++;
            }
          }
          if (!atEndOfNumber()) {
            i = start;
            return false;
          }
          output += invalid ? `"${text.substring(start, i)}"` : num;
          return true;
        }
        return false;
      }
      function parseKeywords() {
        return parseKeyword("true", "true") || parseKeyword("false", "false") || parseKeyword("null", "null") || // repair Python keywords True, False, None
        parseKeyword("True", "true") || parseKeyword("False", "false") || parseKeyword("None", "null");
      }
      function parseKeyword(name, value) {
        if (text.slice(i, i + name.length) === name && !(0, _stringUtils.isFunctionNameChar)(text[i + name.length])) {
          output += value;
          i += name.length;
          return true;
        }
        return false;
      }
      function parseUnquotedString(isKey) {
        const start = i;
        if ((0, _stringUtils.isFunctionNameCharStart)(text[i])) {
          while (i < text.length && (0, _stringUtils.isFunctionNameChar)(text[i])) {
            i++;
          }
          let j = i;
          while ((0, _stringUtils.isWhitespace)(text, j)) {
            j++;
          }
          if (text[j] === "(") {
            i = j + 1;
            parseValue();
            if (text[i] === ")") {
              i++;
              if (text[i] === ";") {
                i++;
              }
            }
            return true;
          }
        }
        while (i < text.length && !(0, _stringUtils.isUnquotedStringDelimiter)(text[i]) && !(0, _stringUtils.isQuote)(text[i]) && (!isKey || text[i] !== ":")) {
          i++;
        }
        if (text[i - 1] === ":" && _stringUtils.regexUrlStart.test(text.substring(start, i + 2))) {
          while (i < text.length && _stringUtils.regexUrlChar.test(text[i])) {
            i++;
          }
        }
        if (i > start) {
          while ((0, _stringUtils.isWhitespace)(text, i - 1) && i > 0) {
            i--;
          }
          const symbol = text.slice(start, i);
          output += symbol === "undefined" ? "null" : JSON.stringify(symbol);
          if (text[i] === '"') {
            i++;
          }
          return true;
        }
      }
      function parseRegex() {
        if (text[i] === "/") {
          const start = i;
          i++;
          while (i < text.length && (text[i] !== "/" || text[i - 1] === "\\")) {
            i++;
          }
          i++;
          output += JSON.stringify(text.substring(start, i));
          return true;
        }
      }
      function prevNonWhitespaceIndex(start) {
        let prev = start;
        while (prev > 0 && (0, _stringUtils.isWhitespace)(text, prev)) {
          prev--;
        }
        return prev;
      }
      function nextQuoteIsEndQuote(index) {
        let next = index + 1;
        while (next < text.length && (0, _stringUtils.isWhitespace)(text, next)) {
          next++;
        }
        return next >= text.length || (0, _stringUtils.isDelimiter)(text[next]);
      }
      function atEndOfNumber() {
        return i >= text.length || (0, _stringUtils.isDelimiter)(text[i]) || (0, _stringUtils.isWhitespace)(text, i);
      }
      function throwInvalidCharacter(char) {
        throw new _JSONRepairError.JSONRepairError(`Invalid character ${JSON.stringify(char)}`, i);
      }
      function throwUnexpectedCharacter() {
        throw new _JSONRepairError.JSONRepairError(`Unexpected character ${JSON.stringify(text[i])}`, i);
      }
      function throwUnexpectedEnd() {
        throw new _JSONRepairError.JSONRepairError("Unexpected end of json string", text.length);
      }
      function throwObjectKeyExpected() {
        throw new _JSONRepairError.JSONRepairError("Object key expected", i);
      }
      function throwColonExpected() {
        throw new _JSONRepairError.JSONRepairError("Colon expected", i);
      }
      function throwInvalidUnicodeCharacter() {
        const chars = text.slice(i, i + 6);
        throw new _JSONRepairError.JSONRepairError(`Invalid unicode character "${chars}"`, i);
      }
    }
    function atEndOfBlockComment(text, i) {
      return text[i] === "*" && text[i + 1] === "/";
    }
  }
});

// vendor/npm/node_modules/jsonrepair/lib/cjs/index.js
var require_cjs = __commonJS({
  "vendor/npm/node_modules/jsonrepair/lib/cjs/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", {
      value: true
    });
    Object.defineProperty(exports2, "JSONRepairError", {
      enumerable: true,
      get: function() {
        return _JSONRepairError.JSONRepairError;
      }
    });
    Object.defineProperty(exports2, "jsonrepair", {
      enumerable: true,
      get: function() {
        return _jsonrepair.jsonrepair;
      }
    });
    var _jsonrepair = require_jsonrepair();
    var _JSONRepairError = require_JSONRepairError();
  }
});

// src/config.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var DEFAULT_CONFIG = {
  baseURL: "",
  model: "",
  provider: "copilot-edge",
  maxToolIterations: 10,
  maxToolExecutions: 8,
  maxWriteExecutions: 3,
  maxCommandExecutions: 2,
  maxNoProgress: 2,
  allowArbitraryCommands: false,
  autoApprove: { write: false, command: false },
  copilot: { displayMode: "foreground", agentMode: true },
  localResponseConverter: { enabled: false, baseURL: "http://127.0.0.1:8080/v1", model: "Qwen3.5-4B-Q4_K_M.gguf", timeoutMs: 3e4, apiKey: "company-apps-flex-local" }
};
function appDataConfigPath() {
  return import_node_path.default.join(process.env.APPDATA ?? process.env.USERPROFILE ?? ".", "CompanyApps", "coding-agent", "config.json");
}
function parseConfig(found) {
  const raw = JSON.parse(import_node_fs.default.readFileSync(found, "utf8"));
  const provider = raw.provider ?? "openai";
  if (provider === "openai" && (!raw.baseURL || !raw.model)) {
    throw new Error(`provider=openai \u306B\u306F baseURL / model \u304C\u5FC5\u8981\u3067\u3059: ${found}`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    provider,
    autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...raw.autoApprove ?? {} },
    copilot: { ...DEFAULT_CONFIG.copilot, ...raw.copilot ?? {} },
    localResponseConverter: { ...DEFAULT_CONFIG.localResponseConverter, ...raw.localResponseConverter ?? {} }
  };
}
function loadConfig(explicitPath) {
  if (explicitPath) {
    if (!import_node_fs.default.existsSync(explicitPath)) throw new Error(`\u6307\u5B9A\u3055\u308C\u305F config \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093: ${explicitPath}`);
    return parseConfig(explicitPath);
  }
  const appDataPath = appDataConfigPath();
  const candidates = [import_node_path.default.join(process.cwd(), "config.json"), appDataPath];
  const found = candidates.find((p) => import_node_fs.default.existsSync(p));
  if (found) return parseConfig(found);
  const dir = import_node_path.default.dirname(appDataPath);
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  import_node_fs.default.writeFileSync(appDataPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  console.log(`\u65E2\u5B9A\u306E\u8A2D\u5B9A\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F: ${appDataPath}`);
  return DEFAULT_CONFIG;
}

// src/copilot.ts
var import_node_child_process = require("node:child_process");
var import_node_net = __toESM(require("node:net"));
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
function selectBrowserProcessId(processInfo) {
  if (!Array.isArray(processInfo)) return null;
  const browser = processInfo.find((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item;
    return String(candidate.type ?? "").toLowerCase() === "browser" && typeof candidate.id === "number" && Number.isSafeInteger(candidate.id) && candidate.id > 0;
  });
  return browser && typeof browser.id === "number" ? browser.id : null;
}
var RESPONSE_STABILITY_MS = 1e3;
var VISIBLE_SESSION_MARKER_PREFIX = "company-apps-coding-agent:";
function makeVisibleSessionMarker(sessionId) {
  const normalized = sessionId.trim();
  if (!/^[a-z0-9_-]{6,80}$/i.test(normalized)) throw new Error("\u8868\u793A\u30BB\u30C3\u30B7\u30E7\u30F3ID\u304C\u4E0D\u6B63\u3067\u3059");
  return VISIBLE_SESSION_MARKER_PREFIX + normalized;
}
function assertResponseDeadline(deadlineMs, responseTimeoutSec, nowMs = Date.now()) {
  if (nowMs >= deadlineMs) throw new Error(`Copilot \u306E\u5FDC\u7B54\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F (${responseTimeoutSec}\u79D2)`);
}
function selectLatestResponseCandidate(candidates) {
  const usable = candidates.filter((candidate) => candidate.text.trim().length > 0);
  usable.sort((a, b) => a.bottom - b.bottom || a.order - b.order);
  return usable.length > 0 ? usable[usable.length - 1] : null;
}
function isStopGenerationControl(candidate) {
  const structural = /fai-SendButton__stopBackground|stopGeneratingButton|stop-button/i.test(candidate.selector);
  const semantic = /stop\s*(?:generating|response)|cancel\s*(?:generation|response)|生成を停止|応答を停止|停止する/i.test(candidate.label);
  return structural || semantic;
}
function updateResponseCompletionState(previous, sample) {
  if (sample.generating || !sample.copyEnabled || sample.text.length <= 0) {
    return { state: { stableText: null, stableSinceMs: null }, ready: false };
  }
  if (previous.stableText !== sample.text || previous.stableSinceMs === null) {
    return {
      state: { stableText: sample.text, stableSinceMs: sample.observedAtMs },
      ready: false
    };
  }
  return {
    state: previous,
    ready: sample.observedAtMs - previous.stableSinceMs >= RESPONSE_STABILITY_MS
  };
}
function resolveCopilotSettings(cfg2) {
  const c = cfg2.copilot ?? {};
  const reuseExistingEdge = c.reuseExistingEdge === true;
  const configuredPort = typeof c.cdpPort === "number" && Number.isInteger(c.cdpPort) && c.cdpPort > 0 ? c.cdpPort : 9445;
  return {
    url: c.url ?? "https://m365.cloud.microsoft/chat/",
    // A fixed port is only honored when the user explicitly opts into attaching to an existing Edge.
    // The normal path allocates a loopback port for an Edge process owned by this client.
    cdpPort: reuseExistingEdge ? configuredPort : 0,
    reuseExistingEdge,
    maxPromptChars: c.maxPromptChars ?? 12e4,
    pollIntervalMs: Math.max(500, c.pollIntervalMs ?? 900),
    responseTimeoutSec: c.responseTimeoutSec ?? 300,
    stallTimeoutSec: c.stallTimeoutSec ?? 120,
    displayMode: c.displayMode === "foreground" ? "foreground" : "minimized",
    endMarker: c.endMarker ?? "AGENT_END",
    agentMode: c.agentMode === true,
    profileName: c.profileName,
    modelPriority: Array.isArray(c.modelPriority) ? c.modelPriority.filter((s) => s && s.trim()) : ["GPT 5.6 Think Deeper", "Opus", "Think Deeper"]
  };
}
var VISIBLE_JS = `const __vis=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};`;
var DOCS_JS = `const __docs=[];const __seenRoots=new Set();const __addRoot=r=>{if(!r||__seenRoots.has(r))return;__seenRoots.add(r);__docs.push(r);let all=[];try{all=Array.from(r.querySelectorAll('*'));}catch(e){}for(const el of all){try{if(el.shadowRoot)__addRoot(el.shadowRoot);}catch(e){}try{if((el.tagName||'').toLowerCase()==='iframe'&&el.contentDocument)__addRoot(el.contentDocument);}catch(e){}}};__addRoot(document);`;
var INPUT_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ ready: true, url: location.href });
  }
  return JSON.stringify({ ready: false, url: location.href });
})()`;
var COPILOT_SCREEN_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  let input = null;
  for (const d of __docs) { input = sels.map(s => ({ s, el: d.querySelector(s) })).find(x => __vis(x.el)); if (input) break; }
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button,[role="button"],a')));
  const responseSelectors = ['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseRootSelectors = ['[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][class*="CopilotMessage" i]','[data-testid="copilot-message-div"]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseSelectorText = responseSelectors.join(',');const responseRootSelectorText=responseRootSelectors.join(',');
  const responseRoot = node => {try{return node.closest(responseRootSelectorText)||node;}catch(e){return node;}};
  const topBottom = node => {const rect=node.getBoundingClientRect();let bottom=Number(rect.bottom)||0;let win=node.ownerDocument&&node.ownerDocument.defaultView;try{while(win&&win!==win.parent&&win.frameElement){bottom+=win.frameElement.getBoundingClientRect().top;win=win.parent;}}catch(e){}return bottom;};
  const controlLabel = el => [el.getAttribute('aria-label'),el.title,el.getAttribute('data-testid'),el.getAttribute('data-automation-id'),el.id,el.className,el.innerText,el.textContent].filter(Boolean).join(' ').trim();
  const enabledCopy = el => {const label=[el.getAttribute('aria-label'),el.title,el.innerText,el.textContent].filter(Boolean).join(' ').trim();const testId=el.getAttribute('data-testid')||'';let inCode=false,inToolbar=false;try{inCode=!!el.closest('pre,code,[data-testid*="code" i]');inToolbar=!!el.closest('[role="toolbar"],.fai-CopilotMessage__actions,[data-testid="CopyButtonContainerTestId"]');}catch(e){}const identity=/^CopyButtonTestId$/i.test(testId)||/(?:\u5FDC\u7B54|\u56DE\u7B54).{0,8}\u30B3\u30D4\u30FC|\u30B3\u30D4\u30FC.{0,8}(?:\u5FDC\u7B54|\u56DE\u7B54)|copy\\s*(?:response|answer)|(?:response|answer)\\s*copy/i.test(label)||(inToolbar&&/^(?:\u30B3\u30D4\u30FC|copy)$/i.test(label));return __vis(el)&&!inCode&&identity&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';};
  const copyForResponse = sourceNode => {
    const ownRoot=responseRoot(sourceNode);let scope=ownRoot;
    for(let depth=0;scope&&depth<6;depth++){
      let others=[];try{others=Array.from(scope.querySelectorAll(responseSelectorText)).filter(el=>responseRoot(el)!==ownRoot);}catch(e){}
      if(others.length>0)break;
      let controls=[];try{controls=Array.from(scope.querySelectorAll('button,[role="button"],span[role="button"]'));}catch(e){}
      if(controls.some(enabledCopy))return true;
      if(scope.tagName&&/^(MAIN|BODY)$/.test(scope.tagName))break;
      scope=scope.parentElement;
    }
    return false;
  };
  const responseCandidates=[];const seenResponses=new Set();let responseOrder=0;
  for(const d of __docs)for(const selector of responseSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const node of nodes){const root=responseRoot(node);if(seenResponses.has(root)||!__vis(node))continue;const text=((node.innerText||'')||(node.textContent||'')).trim();if(!text)continue;seenResponses.add(root);responseCandidates.push({text,bottom:topBottom(root),order:responseOrder++,copyEnabled:copyForResponse(node)});}}
  const stopSelectors=['.fai-SendButton__stopBackground','[data-testid="stopGeneratingButton"]','[data-testid="stop-button"]','[aria-label*="Stop"]','[aria-label*="\u505C\u6B62"]','[aria-label*="Cancel"]','[aria-label*="\u30AD\u30E3\u30F3\u30BB\u30EB"]','[data-testid*="stop" i]'];
  const stopCandidates=[];const seenStops=new Set();
  for(const d of __docs)for(const selector of stopSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const item of nodes){let el=item;try{el=item.closest('button,[role="button"],a')||item;}catch(e){}if(seenStops.has(el)||!__vis(el))continue;seenStops.add(el);stopCandidates.push({label:(controlLabel(el)+' '+controlLabel(item)).trim(),selector});}}
  const signIn = buttons.find(el => __vis(el) && /sign\\s*in|log\\s*in|\u30B5\u30A4\u30F3\u30A4\u30F3|\u30ED\u30B0\u30A4\u30F3/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim()));
  const url = String(location.href || '');
  const signinRequired = /(?:login|signin|sign-in|auth)/i.test(url) || (!input && !!signIn);
  return JSON.stringify({ inputReady: !!input, stopCandidates, responseCandidates, signinRequired, url, title: String(document.title || ''), windowName: String(window.name || ''), sessionMarker: String(document.documentElement.getAttribute('data-company-apps-session') || '') });
})()`;
var FRESH_CHAT_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"], a, [tabindex]')));
  const candidates = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    if (!label) continue;
    let score = 0;
    if (/^(\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|New chat)$/i.test(label)) score += 1000;
    else if (/\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|New chat/i.test(label)) score += 400;
    else if (/\u30C1\u30E3\u30C3\u30C8|chat/i.test(label)) score += 80;
    if (/\u305D\u306E\u4ED6|\u5C65\u6B74|\u691C\u7D22|\u30E9\u30A4\u30D6\u30E9\u30EA|more|history|search|library/i.test(label)) score -= 300;
    if (score <= 0) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    candidates.push({ el: b, label, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) { candidates[0].el.click(); return JSON.stringify({ clicked: true }); }
  return JSON.stringify({ clicked: false });
})()`;
var COPILOT_CLICK_SEND_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const exclude = /stop|cancel|\u505C\u6B62|\u30AD\u30E3\u30F3\u30BB\u30EB|regenerate|\u518D\u751F\u6210|attach|\u6DFB\u4ED8|microphone|voice|\u30DC\u30A4\u30B9|\u97F3\u58F0|new chat|\u65B0\u3057\u3044\u30C1\u30E3\u30C3\u30C8|clear|\u30AF\u30EA\u30A2|close|\u9589\u3058\u308B|search|\u691C\u7D22|library|\u30E9\u30A4\u30D6\u30E9\u30EA|file|\u30D5\u30A1\u30A4\u30EB/;
  const structural = b => b.matches('button[type="submit"],.fai-SendButton,[class*="SendButton" i],[data-testid*="send" i],[data-automation-id*="send" i]');
  const inventory = b => ({ariaLabel:b.getAttribute('aria-label')||'',title:b.title||'',testId:b.getAttribute('data-testid')||'',automationId:b.getAttribute('data-automation-id')||'',className:typeof b.className==='string'?b.className:'',type:b.getAttribute('type')||'',disabled:!!b.disabled,ariaDisabled:b.getAttribute('aria-disabled')||'',visible:__vis(b)});
  const clickable = [];
  for (const b of buttons) {
    const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
    const lower = label.toLowerCase();
    const identity = [lower,b.getAttribute('data-testid'),b.getAttribute('data-automation-id'),typeof b.className==='string'?b.className:''].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    if (/^(\u9001\u4FE1|send)$/i.test(label)) score += 1000;
    else if (structural(b)) score += 600;
    else if (/\u9001\u4FE1|send/i.test(lower)) score += 400;
    if (score <= 0) continue;
    if (exclude.test(identity)) continue;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    if (!__vis(b)) continue;
    clickable.push({ el: b, score, inventory: inventory(b) });
  }
  clickable.sort((a, b) => b.score - a.score);
  if (clickable[0]) { clickable[0].el.click(); return JSON.stringify({ clicked: true, selected:clickable[0].inventory }); }
  const inputSelectors=['#m365-chat-editor-target-element','[data-lexical-editor="true"][contenteditable]','[role="textbox"][contenteditable]'];
  let nearby=[];
  for(const d of __docs)for(const selector of inputSelectors){const input=d.querySelector(selector);if(!input)continue;let scope=input.parentElement;for(let depth=0;scope&&depth<6;depth++,scope=scope.parentElement){const found=Array.from(scope.querySelectorAll('button,[role="button"]'));if(found.length){nearby=found;break;}}if(nearby.length)break;}
  const diagnosticButtons=(nearby.length?nearby:buttons).slice(-32);
  return JSON.stringify({ clicked: false, inventory: diagnosticButtons.map(inventory) });
})()`;
var COPILOT_SEND_READY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const buttons = __docs.flatMap(d => Array.from(d.querySelectorAll('button, [role="button"]')));
  const structural = b => b.matches('button[type="submit"],.fai-SendButton,[class*="SendButton" i],[data-testid*="send" i],[data-automation-id*="send" i]');
  const inventory = b => { const r=b.getBoundingClientRect(); return {ariaLabel:b.getAttribute('aria-label')||'',title:b.title||'',testId:b.getAttribute('data-testid')||'',automationId:b.getAttribute('data-automation-id')||'',className:typeof b.className==='string'?b.className:'',type:b.getAttribute('type')||'',disabled:!!b.disabled,ariaDisabled:b.getAttribute('aria-disabled')||'',visible:__vis(b),rect:{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}}; };
  const candidates = buttons.filter(b => {
    const label=(b.getAttribute('aria-label')||b.title||b.textContent||'').trim();
    return structural(b) || /^(\u9001\u4FE1|send)$/i.test(label);
  });
  const ready = candidates.find(b => __vis(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  return JSON.stringify({ready:!!ready,inventory:candidates.slice(-32).map(inventory)});
})()`;
var EDITOR_LENGTH_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return String((el.textContent || '').replace(/[\\u200B\\u200C]/g, '').length);
  }
  return '-1';
})()`;
var EDITOR_STATE_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) return JSON.stringify({ found: true, text: String(el.textContent || '').replace(/[\\u200B\\u200C]/g, ''), active: d.activeElement === el });
  }
  return JSON.stringify({ found: false, text: '', active: false });
})()`;
function textMismatchDiagnostic(expected, actual) {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index++;
  const start = Math.max(0, index - 12);
  const end = index + 20;
  const expectedSlice = expected.slice(start, end);
  const actualSlice = actual.slice(start, end);
  const code = (value) => Array.from(value).map((char) => char.codePointAt(0)?.toString(16).padStart(4, "0")).join(" ");
  return `first=${index} expected=${JSON.stringify(expectedSlice)} [${code(expectedSlice)}] actual=${JSON.stringify(actualSlice)} [${code(actualSlice)}] lengths=${expected.length}/${actual.length}`;
}
var CLEAR_EDITOR_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
  for (const d of __docs) for (const s of sels) {
    const el = d.querySelector(s);
    if (__vis(el)) { el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return 'ok'; }
  }
  return 'ng';
})()`;
var MODEL_SELECT_JS = String.raw`(async () => {
  const candidates = __CANDIDATES__;
  const switcherSelector = __SWITCHER__;
  const docs=[document];for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const stripTail = s => norm(s).replace(/[…‥]|\.{3}$/g, '');
  const eq = (a,b) => a.toLowerCase() === b.toLowerCase();
  const has = (a,b) => a.toLowerCase().indexOf(b.toLowerCase()) !== -1;
  const matchesModel = (shown,cand,picked) => {
    const a = stripTail(shown); if (!a) return false;
    if (eq(a,cand) || has(a,cand)) return true;
    if (picked && (eq(a,picked) || has(a,picked))) return true;
    return a.length >= 6 && (has(cand,a) || (picked && has(picked,a)));
  };
  const visible=e=>{if(!e)return false;const d=e.ownerDocument,w=d.defaultView,cs=w.getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden')return false;const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return true;if(!(d.visibilityState==='hidden'||w.innerWidth===0||w.innerHeight===0))return false;try{if(typeof e.checkVisibility==='function')return e.checkVisibility({visibilityProperty:true});}catch(x){}return true;};
  const primaryLabel = el => { const p=el.querySelector('.fai-CapabilityPickerMenuItem__primaryContentWrapper'); if(p)return norm(p.innerText); const c=el.querySelector('.fui-MenuItem__content > span:first-child'); if(c)return norm(c.innerText); return norm((el.innerText||'').split('\n')[0]); };
  const subTextOf = el => { const s=el.querySelector('.fai-CapabilityPickerMenuItem__subText'); return s?norm(s.innerText):''; };
  const itemSelector='[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]';
  const menuRoot=()=>{for(const d of docs){const r=d.querySelector('.fui-MenuPopover')||d.querySelector('[data-portal-node] [role="menu"]');if(r)return r;}return null;};
  const collectItems=()=>{const r=menuRoot();return r?Array.from(r.querySelectorAll(itemSelector)).filter(visible):[];};
  const collectItemsAll=()=>{const roots=docs.flatMap(d=>Array.from(d.querySelectorAll('.fui-MenuPopover, [data-portal-node] [role="menu"]'))).filter(visible);return Array.from(new Set(roots.flatMap(r=>Array.from(r.querySelectorAll(itemSelector)).filter(visible))));};
  const pressEscape=()=>{try{const o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};const t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));}catch(e){}};
  const fireEnter=el=>{try{el.focus();const o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true};el.dispatchEvent(new KeyboardEvent('keydown',o));el.dispatchEvent(new KeyboardEvent('keyup',o));return true;}catch(e){return false;}};
  const fireMenuClick=async el=>{try{const r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2,base={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy};el.dispatchEvent(new PointerEvent('pointerover',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mouseover',base));el.dispatchEvent(new PointerEvent('pointermove',{...base,pointerType:'mouse'}));el.dispatchEvent(new MouseEvent('mousemove',base));try{el.focus();}catch(e){}await sleep(60);el.dispatchEvent(new PointerEvent('pointerdown',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mousedown',{...base,button:0}));el.dispatchEvent(new PointerEvent('pointerup',{...base,pointerType:'mouse',button:0}));el.dispatchEvent(new MouseEvent('mouseup',{...base,button:0}));el.dispatchEvent(new MouseEvent('click',{...base,button:0}));try{el.click();}catch(e){}return true;}catch(e){return false;}};
  const findSwitcher=()=>{for(const d of docs){let b=d.querySelector(switcherSelector);if(b&&visible(b))return b;b=Array.from(d.querySelectorAll('button[aria-haspopup="menu"]')).find(x=>visible(x)&&(/モデル/.test(x.getAttribute('aria-label')||'')||/model/i.test(x.getAttribute('aria-label')||'')));if(b)return b;}return null;};
  const labelItems=xs=>xs.map(el=>({el,label:primaryLabel(el),submenu:el.getAttribute('aria-haspopup')==='menu',testId:el.getAttribute('data-test-id')||'',checked:el.getAttribute('aria-checked')==='true'})).filter(x=>x.label);
  const isGptTrigger=x=>/^gptSubMenuModelTrigger/i.test(x.testId)||(x.submenu&&/^gpt/i.test(x.label))||(x.submenu&&has(subTextOf(x.el),'OpenAI'));
  const findHit=(xs,c)=>xs.find(x=>eq(x.label,c))||xs.find(x=>has(x.label,c))||(/^gpt/i.test(c)?xs.find(isGptTrigger):null);
  const btn=findSwitcher();
  if(!btn)return JSON.stringify({ok:true,changed:false,reason:'switcher_not_found'});
  const current=norm(btn.innerText);
  if(candidates.length&&matchesModel(current,candidates[0],''))return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:candidates[0]});
  await fireMenuClick(btn);
  let items=[];for(let i=0;i<30;i++){items=collectItems();if(items.length)break;await sleep(100);}if(items.length){await sleep(150);const a=collectItems();if(a.length)items=a;}
  if(!items.length){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'menu_not_found',current});}
  let labeled=labelItems(items),skipped=[],observedSubMenuItems=[];
  const clickAndConfirm=async(hit,cand)=>{
    const before=new Set(collectItemsAll());await fireMenuClick(hit.el);let picked=hit.label,clicked=hit.el;
    if(hit.submenu){let fresh=[];for(let i=0;i<20;i++){fresh=collectItemsAll().filter(x=>!before.has(x));if(fresh.length)break;await sleep(100);}if(fresh.length){const sub=fresh.map(el=>({el,label:primaryLabel(el)})).filter(x=>x.label);observedSubMenuItems=sub.map(x=>x.label).slice(0,16);const suffix=cand.replace(/^GPT[\s-]*[\d.]*\s*/i,'');const h=sub.find(x=>eq(x.label,cand))||sub.find(x=>has(x.label,cand))||sub.find(x=>eq(x.label,suffix))||sub.find(x=>suffix&&has(x.label,suffix))||sub.find(x=>has(cand,x.label)&&x.label.length>=4);if(!h)return{applied:false,reason:'submenu_no_match'};picked=h.label;clicked=h.el;await fireMenuClick(clicked);}}
    const timeout=hit.submenu?5000:2000,t0=Date.now();let keyboard=false;
    while(Date.now()-t0<timeout){await sleep(hit.submenu?50:100);after_loop:{}
      const after=norm((findSwitcher()||{innerText:''}).innerText);
      if(matchesModel(after,cand,picked))return{applied:true,after,picked};
      const still=menuRoot()!==null;
      if(hit.submenu&&still&&!keyboard&&(Date.now()-t0)>=800){keyboard=true;fireEnter(clicked);}
    }
    return{applied:false,reason:'confirm_failed'};
  };
  for(let pi=0;pi<candidates.length;pi++){const cand=candidates[pi],hit=findHit(labeled,cand);if(!hit){skipped.push(cand);continue;}
    if(hit.checked){pressEscape();return JSON.stringify({ok:true,changed:false,reason:'already_selected',current,picked:hit.label});}
    const r=await clickAndConfirm(hit,cand);
    if(r.applied)return JSON.stringify({ok:true,changed:true,reason:'selected',before:current,after:r.after,picked:r.picked});
    pressEscape();await sleep(150);pressEscape();await sleep(700);
    const after2=norm((findSwitcher()||{innerText:''}).innerText);
    if(matchesModel(after2,cand,r.picked||''))return JSON.stringify({ok:true,changed:true,reason:'selected_late',before:current,after:after2,picked:r.picked});
  }
  pressEscape();return JSON.stringify({ok:true,changed:false,reason:'model_not_in_menu',current,tried:candidates,skipped});
})()`;
var COPILOT_CLICK_COPY_JS = `(() => {
  ${VISIBLE_JS}
  ${DOCS_JS}
  const responseSelectors=['[data-testid="markdown-reply"]','[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseRootSelectors=['[data-content="ai-message"]','[class*="ai-message" i]','[role="article"][class*="CopilotMessage" i]','[data-testid="copilot-message-div"]','[role="article"][data-author="assistant"]','[role="article"][aria-label*="Copilot" i]','[data-message-author-role="assistant"]'];
  const responseSelectorText=responseSelectors.join(',');const responseRootSelectorText=responseRootSelectors.join(',');
  const responseRoot=node=>{try{return node.closest(responseRootSelectorText)||node;}catch(e){return node;}};
  const topBottom=node=>{const rect=node.getBoundingClientRect();let bottom=Number(rect.bottom)||0;let win=node.ownerDocument&&node.ownerDocument.defaultView;try{while(win&&win!==win.parent&&win.frameElement){bottom+=win.frameElement.getBoundingClientRect().top;win=win.parent;}}catch(e){}return bottom;};
  const labelOf=el=>[el.getAttribute('aria-label'),el.title,el.getAttribute('data-testid'),el.getAttribute('data-automation-id'),el.id,el.className,el.innerText,el.textContent].filter(Boolean).join(' ').trim();
  const enabledCopy=el=>{const label=[el.getAttribute('aria-label'),el.title,el.innerText,el.textContent].filter(Boolean).join(' ').trim();const testId=el.getAttribute('data-testid')||'';let inCode=false,inToolbar=false;try{inCode=!!el.closest('pre,code,[data-testid*="code" i]');inToolbar=!!el.closest('[role="toolbar"],.fai-CopilotMessage__actions,[data-testid="CopyButtonContainerTestId"]');}catch(e){}const identity=/^CopyButtonTestId$/i.test(testId)||/(?:\u5FDC\u7B54|\u56DE\u7B54).{0,8}\u30B3\u30D4\u30FC|\u30B3\u30D4\u30FC.{0,8}(?:\u5FDC\u7B54|\u56DE\u7B54)|copy\\s*(?:response|answer)|(?:response|answer)\\s*copy/i.test(label)||(inToolbar&&/^(?:\u30B3\u30D4\u30FC|copy)$/i.test(label));return __vis(el)&&!inCode&&identity&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';};
  const responses=[];const seenResponses=new Set();let order=0;
  for(const d of __docs)for(const selector of responseSelectors){let nodes=[];try{nodes=Array.from(d.querySelectorAll(selector));}catch(e){}for(const node of nodes){const root=responseRoot(node);if(seenResponses.has(root)||!__vis(node))continue;const text=((node.innerText||'')||(node.textContent||'')).trim();if(!text)continue;seenResponses.add(root);responses.push({node:root,bottom:topBottom(root),order:order++});}}
  responses.sort((a,b)=>(a.bottom-b.bottom)||(a.order-b.order));
  const latest=responses.length?responses[responses.length-1].node:null;
  let cand=[];let scope=latest;
  for(let depth=0;scope&&depth<6;depth++){
    let others=[];try{others=Array.from(scope.querySelectorAll(responseSelectorText)).filter(el=>responseRoot(el)!==latest);}catch(e){}
    if(others.length>0)break;
    let controls=[];try{controls=Array.from(scope.querySelectorAll('button,[role="button"],span[role="button"]'));}catch(e){}
    cand=controls.filter(enabledCopy);if(cand.length)break;
    if(scope.tagName&&/^(MAIN|BODY)$/.test(scope.tagName))break;
    scope=scope.parentElement;
  }
  const labels = cand.slice(-5).map((b) => (b.getAttribute('aria-label') || b.title || b.tagName).slice(0, 40));
  if (cand.length === 0) return JSON.stringify({ clicked: false, found: 0, sample: labels });
  const last = cand[cand.length - 1];
  try { last.scrollIntoView({ block: 'center' }); } catch (e) {}
  last.click();
  return JSON.stringify({ clicked: true, found: cand.length, label: (last.getAttribute('aria-label') || '').slice(0, 40) });
})()`;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var throwIfAborted = (signal) => {
  if (signal?.aborted) throw new Error("Copilot\u5B9F\u884C\u306F\u30AD\u30E3\u30F3\u30BB\u30EB\u3055\u308C\u307E\u3057\u305F");
};
var CdpConnection = class _CdpConnection {
  ws;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
  }
  static async connect(url, timeoutMs = 15e3) {
    const ctor = globalThis.WebSocket;
    if (!ctor) throw new Error("\u3053\u306E Node.js \u306B\u306F\u6A19\u6E96 WebSocket \u304C\u3042\u308A\u307E\u305B\u3093 (v22+ \u3092\u4F7F\u7528\u3057\u3066\u304F\u3060\u3055\u3044)");
    const ws = new ctor(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket \u63A5\u7D9A\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP WebSocket \u63A5\u7D9A\u306B\u5931\u6557\u3057\u307E\u3057\u305F"));
      }, { once: true });
    });
    return new _CdpConnection(ws);
  }
  onMessage(raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof obj.id !== "number") return;
    const p = this.pending.get(obj.id);
    if (!p) return;
    this.pending.delete(obj.id);
    clearTimeout(p.timer);
    if (obj.error !== void 0) p.reject(new Error(`CDP \u30A8\u30E9\u30FC: ${JSON.stringify(obj.error).slice(0, 300)}`));
    else p.resolve(obj.result);
  }
  async method(name, params = {}, timeoutMs = 3e4) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP \u5FDC\u7B54\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8: ${name}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ id, method: name, params }));
    return p;
  }
  async evalJs(expression, timeoutMs = 3e4) {
    const r = await this.method(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    );
    if (r && typeof r === "object" && "exceptionDetails" in r && r.exceptionDetails) {
      throw new Error("JavaScript evaluation failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    const rr = r;
    return rr?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP \u63A5\u7D9A\u3092\u5207\u65AD\u3057\u307E\u3057\u305F"));
    }
    this.pending.clear();
  }
};
function isLocalUrl(url) {
  if (!url) return true;
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}
async function devToolsUp(port2) {
  try {
    const res = await fetch(`http://127.0.0.1:${port2}/json/version`, { signal: AbortSignal.timeout(2e3) });
    return res.ok;
  } catch {
    return false;
  }
}
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server2 = import_node_net.default.createServer();
    server2.once("error", reject);
    server2.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server2.address();
      const port2 = typeof address === "object" && address ? address.port : 0;
      server2.close((error) => {
        if (error) reject(error);
        else if (port2 > 0) resolve(port2);
        else reject(new Error("Edge\u7528\u306E\u7A7A\u304D\u30DD\u30FC\u30C8\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F"));
      });
    });
  });
}
function profileIsInUse(profileDir) {
  if (["SingletonLock", "SingletonCookie", "SingletonSocket"].some((name) => import_node_fs2.default.existsSync(import_node_path2.default.join(profileDir, name)))) return true;
  if (process.platform !== "win32") return false;
  try {
    const needle = import_node_path2.default.resolve(profileDir).replace(/[\\/]+$/, "").toLowerCase();
    const marker = `--user-data-dir=${needle}`;
    const output = (0, import_node_child_process.execFileSync)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object -ExpandProperty CommandLine`
    ], { encoding: "utf8", timeout: 3e3, windowsHide: true });
    return output.split(/\r?\n/).some((line) => {
      const normalized = line.toLowerCase().replaceAll('"', "");
      const index = normalized.indexOf(marker);
      return index >= 0 && (index + marker.length === normalized.length || /\s/.test(normalized[index + marker.length]));
    });
  } catch {
    return true;
  }
}
function findEdgePath() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const p = import_node_path2.default.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (import_node_fs2.default.existsSync(p)) return p;
  }
  throw new Error("Microsoft Edge \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002Edge \u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
}
var CopilotEdgeClient = class {
  name = "copilot-edge";
  s;
  cdp = null;
  clipGranted = false;
  ownedEdgePid = null;
  visibleEdgePid = null;
  edgeProfileDir = null;
  visibleSessionId = null;
  lastTiming = null;
  constructor(cfg2) {
    this.s = resolveCopilotSettings(cfg2);
  }
  remainingTimeoutMs(deadlineMs, maximumMs) {
    if (!Number.isFinite(deadlineMs)) return maximumMs;
    const remainingMs = Math.floor(deadlineMs - Date.now());
    if (remainingMs <= 0) throw new Error("Copilot response deadline exhausted");
    return Math.max(1, Math.min(maximumMs, remainingMs));
  }
  async grantClipboard(deadlineMs = Number.POSITIVE_INFINITY) {
    if (this.clipGranted) return;
    const ver = await (await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(this.remainingTimeoutMs(deadlineMs, 5e3))
    })).json();
    const browserWs = String(ver.webSocketDebuggerUrl ?? "");
    if (!browserWs) throw new Error("browser WebSocket \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093");
    const bws = await CdpConnection.connect(browserWs, this.remainingTimeoutMs(deadlineMs, 1e4));
    try {
      await bws.method("Browser.grantPermissions", {
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
        origin: new URL(this.s.url).origin
      }, this.remainingTimeoutMs(deadlineMs, 1e4));
    } finally {
      bws.close();
    }
    this.clipGranted = true;
  }
  async refreshBrowserProcessId(deadlineMs = Number.POSITIVE_INFINITY) {
    this.visibleEdgePid = null;
    const ver = await (await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/version`, {
      signal: AbortSignal.timeout(this.remainingTimeoutMs(deadlineMs, 5e3))
    })).json();
    const browserWs = String(ver.webSocketDebuggerUrl ?? "");
    if (!browserWs) throw new Error("browser WebSocket \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093");
    const bws = await CdpConnection.connect(browserWs, this.remainingTimeoutMs(deadlineMs, 1e4));
    try {
      const result = await bws.method("SystemInfo.getProcessInfo", {}, this.remainingTimeoutMs(deadlineMs, 1e4));
      const browserPid = selectBrowserProcessId(result?.processInfo);
      if (browserPid === null) throw new Error("CDP\u304B\u3089Edge\u30D6\u30E9\u30A6\u30B6\u30FC\u672C\u4F53PID\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
      this.visibleEdgePid = browserPid;
    } finally {
      bws.close();
    }
  }
  stripOuterFence(t) {
    let s = t.trim();
    const m = s.match(/^```[\w-]*[ \t]*\r?\n([\s\S]*)\r?\n?```\s*$/);
    if (m) s = m[1];
    return s.split("\n").filter((l) => l.trim() !== this.s.endMarker).join("\n").trim();
  }
  async bringToFront(deadlineMs = Number.POSITIVE_INFINITY) {
    try {
      await this.cdpMethod("Page.bringToFront", {}, this.remainingTimeoutMs(deadlineMs, 5e3));
      const pauseMs = this.remainingTimeoutMs(deadlineMs, 300);
      await sleep(pauseMs);
    } catch {
    }
  }
  readSystemClipboard(deadlineMs = Number.POSITIVE_INFINITY) {
    if (process.platform !== "win32") return "";
    try {
      return String((0, import_node_child_process.execFileSync)("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-Clipboard -Raw"
      ], {
        encoding: "utf8",
        timeout: this.remainingTimeoutMs(deadlineMs, 5e3),
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      })).trim();
    } catch {
      return "";
    }
  }
  async finalizeAnswer(fallbackText, deadlineMs = Number.POSITIVE_INFINITY) {
    const assertWithinDeadline = () => {
      assertResponseDeadline(deadlineMs, this.s.responseTimeoutSec);
    };
    const sleepWithinDeadline = async (requestedMs) => {
      assertWithinDeadline();
      await sleep(this.remainingTimeoutMs(deadlineMs, requestedMs));
      assertWithinDeadline();
    };
    let baseline = "";
    try {
      await this.bringToFront(deadlineMs);
      assertWithinDeadline();
      baseline = this.readSystemClipboard(deadlineMs);
      if (!baseline) {
        await this.grantClipboard(deadlineMs);
        baseline = String(await this.evalWithReconnect("navigator.clipboard.readText()", this.remainingTimeoutMs(deadlineMs, 8e3))).trim();
      }
    } catch {
    }
    assertWithinDeadline();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.bringToFront(deadlineMs);
        assertWithinDeadline();
        await this.grantClipboard(deadlineMs);
        const clicked = JSON.parse(String(await this.evalWithReconnect(
          COPILOT_CLICK_COPY_JS,
          this.remainingTimeoutMs(deadlineMs, 15e3)
        )));
        console.log("[clip] candidates=" + JSON.stringify(clicked));
        if (clicked.clicked) {
          await sleepWithinDeadline(400 + attempt * 200);
          let clip = this.readSystemClipboard(deadlineMs);
          if (!clip || clip.trim() === baseline) {
            clip = String(await this.evalWithReconnect(
              "navigator.clipboard.readText()",
              this.remainingTimeoutMs(deadlineMs, 1e4)
            ));
          } else {
            console.log("[clip] read via Windows clipboard");
          }
          assertWithinDeadline();
          const s = this.stripOuterFence(clip);
          if (s.trim().length >= 10 && s.trim() !== baseline) {
            assertWithinDeadline();
            return s;
          }
        }
      } catch (err) {
        assertWithinDeadline();
        console.log("[clip] attempt " + attempt + " error: " + err.message.slice(0, 80));
      }
      await sleepWithinDeadline(700);
    }
    assertWithinDeadline();
    console.log("[clip] fallback to innerText");
    const cleaned = this.cleanResponse(fallbackText);
    assertWithinDeadline();
    return cleaned;
  }
  hardenPreferences(profileDir) {
    try {
      const prefPath = import_node_path2.default.join(profileDir, "Default", "Preferences");
      if (!import_node_fs2.default.existsSync(prefPath)) return;
      const j = JSON.parse(import_node_fs2.default.readFileSync(prefPath, "utf8"));
      if (!j.session) j.session = {};
      j.session.restore_on_startup = 4;
      j.session.startup_urls = [];
      if (j.profile) j.profile.exit_type = "Normal";
      import_node_fs2.default.writeFileSync(prefPath, JSON.stringify(j), "utf8");
    } catch {
    }
  }
  chooseEdgeProfile() {
    const root = import_node_path2.default.join(process.env.APPDATA ?? process.env.USERPROFILE ?? ".", "CompanyApps", "coding-agent");
    import_node_fs2.default.mkdirSync(root, { recursive: true });
    const suffix = (this.s.profileName ?? "default").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
    const stable = import_node_path2.default.join(root, suffix === "default" ? "edge-profile" : "edge-profile-" + suffix);
    if (!profileIsInUse(stable)) return stable;
    return import_node_fs2.default.mkdtempSync(import_node_path2.default.join(root, "edge-profile-" + suffix + "-session-"));
  }
  async ensureEdge() {
    if (this.s.reuseExistingEdge) {
      if (this.s.cdpPort > 0 && await devToolsUp(this.s.cdpPort)) return;
      if (this.s.cdpPort <= 0) throw new Error("\u65E2\u5B58Edge\u63A5\u7D9A\u3092\u518D\u5229\u7528\u3059\u308B\u306B\u306F copilot.cdpPort \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
    } else {
      if (this.ownedEdgePid !== null && await devToolsUp(this.s.cdpPort)) return;
      this.s.cdpPort = await findFreePort();
    }
    const userDataDir = this.edgeProfileDir ?? this.chooseEdgeProfile();
    this.edgeProfileDir = userDataDir;
    this.hardenPreferences(userDataDir);
    const args = [
      `--remote-debugging-port=${this.s.cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,msEdgeTranslate",
      "--disable-sync",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble"
    ];
    if (this.s.displayMode === "minimized") args.push("--window-position=-32000,-32000", "--window-size=1280,900");
    args.push(this.s.url);
    const child = (0, import_node_child_process.spawn)(findEdgePath(), args, { detached: true, stdio: "ignore" });
    this.ownedEdgePid = child.pid ?? null;
    this.visibleEdgePid = null;
    child.unref();
    const deadline = Date.now() + 3e4;
    while (Date.now() < deadline) {
      if (await devToolsUp(this.s.cdpPort)) return;
      await sleep(500);
    }
    const mode = this.s.reuseExistingEdge ? "\u6307\u5B9A\u3055\u308C\u305FEdge" : "\u5C02\u7528Edge";
    throw new Error(`${mode}\u306EDevTools Protocol\u304C\u8D77\u52D5\u3057\u307E\u305B\u3093\u3067\u3057\u305F (port=${this.s.cdpPort})\u3002\u4ED6\u30A2\u30D7\u30EA\u306EEdge\u306B\u306F\u63A5\u7D9A\u305B\u305A\u3001\u5C02\u7528\u30D7\u30ED\u30D5\u30A1\u30A4\u30EB\u3067\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  }
  async listTargets() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json`, { signal: AbortSignal.timeout(5e3) });
      const raw = await res.json();
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  async ensurePage() {
    const host = (() => {
      try {
        return new URL(this.s.url).host;
      } catch {
        return "";
      }
    })();
    for (let attempt = 0; attempt < 3; attempt++) {
      const targets = await this.listTargets();
      const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !isLocalUrl(t.url));
      const preferred = pages.find((t) => host && t.url?.includes(host) || t.url?.toLowerCase().includes("copilot"));
      const fallback = this.s.reuseExistingEdge ? pages.find((t) => /^https?:/i.test(t.url ?? "")) : void 0;
      const picked = preferred ?? fallback;
      if (picked) {
        this.cdp?.close();
        this.cdp = await CdpConnection.connect(picked.webSocketDebuggerUrl);
        return;
      }
      const created = await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
        method: "PUT",
        signal: AbortSignal.timeout(5e3)
      }).catch(() => null);
      if (!created?.ok) {
        await fetch(`http://127.0.0.1:${this.s.cdpPort}/json/new?${encodeURIComponent(this.s.url)}`, {
          signal: AbortSignal.timeout(5e3)
        }).catch(() => null);
      }
      await sleep(2e3);
    }
    throw new Error("Copilot \u30DA\u30FC\u30B8 (CDP \u30BF\u30FC\u30B2\u30C3\u30C8) \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
  }
  async assertTrustedOrigin() {
    const actualRaw = String(await this.evalWithReconnect("(() => location.origin)()"));
    const u = new URL(this.s.url);
    if (u.protocol !== "https:" || !u.host) {
      throw new Error(`copilot.url \u306F https \u306E\u7D76\u5BFE URL \u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044: ${this.s.url}`);
    }
    let actualHost = "";
    try {
      const au = new URL(actualRaw);
      if (au.protocol !== "https:") throw new Error("not https");
      actualHost = au.host.toLowerCase();
    } catch {
      throw new Error(`Copilot \u306E\u9001\u4FE1\u5148\u304C\u4E0D\u6B63\u3067\u3059: ${actualRaw}`);
    }
    if (actualHost !== u.host.toLowerCase()) {
      throw new Error(`Copilot \u306E\u9001\u4FE1\u5148\u304C\u8A2D\u5B9A\u3068\u4E00\u81F4\u3057\u307E\u305B\u3093 (expected=${u.host}, actual=${actualHost})`);
    }
  }
  async evalWithReconnect(expr, timeoutMs = 2e4) {
    if (!this.cdp) throw new Error("Copilot \u30DA\u30FC\u30B8\u672A\u63A5\u7D9A\u3067\u3059");
    return this.cdp.evalJs(expr, timeoutMs);
  }
  async waitInputReady(timeoutSec, signal) {
    const deadline = Date.now() + timeoutSec * 1e3;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const raw = await this.evalWithReconnect(INPUT_READY_JS, 15e3);
      const state = JSON.parse(String(raw));
      if (/login|signin|sign-in|auth/i.test(state.url)) {
        throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002Edge \u30A6\u30A3\u30F3\u30C9\u30A6\u3067\u30B5\u30A4\u30F3\u30A4\u30F3\u3057\u3066\u304B\u3089\u518D\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      if (state.ready) return;
      await sleep(350);
      throwIfAborted(signal);
    }
    throw new Error("Copilot \u306E\u5165\u529B\u6B04\u304C\u6E96\u5099\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F (\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8)\u3002");
  }
  async freshChat() {
    const raw = await this.evalWithReconnect(FRESH_CHAT_JS);
    if (!JSON.parse(String(raw)).clicked) {
      await this.cdpMethod("Page.navigate", { url: this.s.url });
      await sleep(3e3);
    } else {
      await sleep(450);
    }
  }
  async stampVisibleSessionMarker(sessionId) {
    const marker = makeVisibleSessionMarker(sessionId);
    const result = await this.evalWithReconnect(`(() => { const marker = ${JSON.stringify(marker)}; window.name = marker; document.documentElement.setAttribute('data-company-apps-session', marker); return JSON.stringify({ windowName: window.name, sessionMarker: document.documentElement.getAttribute('data-company-apps-session') }); })()`);
    const stamped = JSON.parse(String(result));
    if (stamped.windowName !== marker || stamped.sessionMarker !== marker) throw new Error("Copilot\u8868\u793A\u30BF\u30D6\u3078\u30BB\u30C3\u30B7\u30E7\u30F3\u8B58\u5225\u5B50\u3092\u8A2D\u5B9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  async prepareVisibleSession(sessionId) {
    makeVisibleSessionMarker(sessionId);
    await this.ensureEdge();
    await this.ensurePage();
    await this.refreshBrowserProcessId();
    await this.cdpMethod("Page.navigate", { url: this.s.url });
    await sleep(3e3);
    await this.waitInputReady(120);
    await this.assertTrustedOrigin();
    this.visibleSessionId = sessionId;
    await this.stampVisibleSessionMarker(sessionId);
    await this.bringToFront();
    return this.inspectVisibleSession(sessionId);
  }
  async inspectVisibleSession(sessionId) {
    const expectedMarker = makeVisibleSessionMarker(sessionId);
    if (!this.cdp) throw new Error("Copilot\u8868\u793A\u30BF\u30D6\u306F\u6E96\u5099\u3055\u308C\u3066\u3044\u307E\u305B\u3093");
    const raw = await this.evalWithReconnect(COPILOT_SCREEN_STATE_JS, 15e3);
    const parsed = JSON.parse(String(raw));
    const responses = parsed.responseCandidates ?? [];
    const latest = selectLatestResponseCandidate(responses);
    const marker = String(parsed.sessionMarker ?? "");
    return {
      sessionId,
      marker,
      markerMatches: marker === expectedMarker && String(parsed.windowName ?? "") === expectedMarker,
      pid: this.visibleEdgePid,
      cdpPort: this.s.cdpPort,
      url: String(parsed.url ?? ""),
      title: String(parsed.title ?? ""),
      inputReady: parsed.inputReady === true,
      responseCount: responses.length,
      latestResponseLength: latest?.text.length ?? 0,
      generating: (parsed.stopCandidates ?? []).some(isStopGenerationControl),
      copyEnabled: latest?.copyEnabled === true
    };
  }
  async cdpMethod(name, params, timeoutMs = 3e4) {
    if (!this.cdp) throw new Error("Copilot \u30DA\u30FC\u30B8\u672A\u63A5\u7D9A\u3067\u3059");
    await this.cdp.method(name, params, timeoutMs);
  }
  async editorLength() {
    const raw = await this.evalWithReconnect(EDITOR_LENGTH_JS);
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }
  async editorState() {
    const raw = await this.evalWithReconnect(EDITOR_STATE_JS);
    try {
      const state = JSON.parse(String(raw));
      return { found: state.found === true, text: typeof state.text === "string" ? state.text : "", active: state.active === true };
    } catch {
      return { found: false, text: "", active: false };
    }
  }
  async insertPrompt(prompt) {
    if (prompt.length > this.s.maxPromptChars) {
      throw new Error(`\u4F9D\u983C\u6587\u304C\u4E0A\u9650 ${this.s.maxPromptChars} \u6587\u5B57\u3092\u8D85\u3048\u3066\u3044\u307E\u3059 (${prompt.length} \u6587\u5B57)`);
    }
    let lastDirectError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.insertDirect(prompt);
        if (attempt > 1) console.log("[input] \u5358\u4E00Input.insertText\u306E\u518D\u8A66\u884C\u3067\u6210\u529F");
        return;
      } catch (err) {
        lastDirectError = err.message;
        console.log(`[input] \u5358\u4E00Input.insertText attempt=${attempt} failed: ${lastDirectError}`);
        if (attempt < 2) await sleep(300);
      }
    }
    console.log(`[input] \u5358\u4E00Input.insertText\u30922\u56DE\u78BA\u8A8D\u3067\u304D\u305A\u3001\u30C1\u30E3\u30F3\u30AF\u65B9\u5F0F\u3078\u30D5\u30A9\u30FC\u30EB\u30D0\u30C3\u30AF: ${lastDirectError}`);
    await this.insertByChunks(prompt);
  }
  async insertDirect(prompt) {
    if (await this.editorLength() > 0) await this.clearEditor();
    await this.bringToFront();
    await this.focusEditor();
    const timeoutMs = prompt.length > 12e3 ? 9e4 : prompt.length > 5e3 ? 6e4 : 3e4;
    await this.cdpMethod("Input.insertText", { text: prompt }, timeoutMs);
    let final = await this.editorState();
    for (let poll = 0; poll < 12 && (!final.found || final.text !== prompt); poll++) {
      await sleep(150);
      final = await this.editorState();
    }
    if (!final.found || final.text !== prompt) throw new Error(`\u8CBC\u308A\u4ED8\u3051\u5F8C\u306E\u5185\u5BB9\u4E0D\u4E00\u81F4 (${textMismatchDiagnostic(prompt, final.text)})`);
    const send = await this.waitSendReady(6e3);
    if (!send.ready) throw new Error("\u5358\u4E00Input.insertText\u5F8C\u3082\u9001\u4FE1\u30DC\u30BF\u30F3\u304C\u6709\u52B9\u306B\u306A\u308A\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  async insertByChunks(prompt) {
    if (await this.editorLength() > 0) {
      await this.clearEditor();
    }
    let pos = 0;
    let chunkSize = 450;
    let rebuilds = 0;
    while (pos < prompt.length) {
      const chunk = prompt.slice(pos, pos + chunkSize);
      let ok = false;
      for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
        const before = await this.editorState();
        if (!before.found) throw new Error("\u5165\u529B\u6B04\u304C\u518D\u63CF\u753B\u4E2D\u3067\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F");
        if (!prompt.startsWith(before.text)) {
          const diagnostic = textMismatchDiagnostic(prompt, before.text);
          console.warn(`[input] DOM\u6587\u5B57\u5217\u4E0D\u4E00\u81F4: ${diagnostic}`);
          if (rebuilds >= 2) throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u5185\u5BB9\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093\u3067\u3057\u305F (${diagnostic})`);
          await this.clearEditor();
          pos = 0;
          rebuilds++;
          break;
        }
        if (before.text.length > pos) {
          pos = before.text.length;
          ok = true;
          break;
        }
        await this.bringToFront();
        await this.focusEditor();
        await this.cdpMethod("Input.insertText", { text: prompt.slice(pos, pos + chunk.length) });
        for (let poll = 0; poll < 8; poll++) {
          await sleep(180);
          const after = await this.editorState();
          if (!after.found || !prompt.startsWith(after.text)) break;
          if (after.text.length > pos) {
            pos = after.text.length;
            ok = true;
            break;
          }
        }
        if (!ok) await sleep(250 * attempt);
      }
      if (!ok) {
        if (pos >= prompt.length) break;
        if (chunkSize > 180) {
          chunkSize = Math.floor(chunkSize / 2);
          continue;
        }
        if (rebuilds >= 2) {
          throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u304C\u4F4D\u7F6E ${pos} \u3067\u53CD\u6620\u3055\u308C\u307E\u305B\u3093\u3067\u3057\u305F`);
        }
        await this.clearEditor();
        pos = 0;
        rebuilds++;
      }
    }
    const final = await this.editorState();
    if (!final.found || !final.text.startsWith(prompt)) {
      throw new Error(`\u4F9D\u983C\u6587\u306E\u5165\u529B\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F (\u671F\u5F85 ${prompt.length} / \u5B9F\u969B ${final.text.length})`);
    }
  }
  async clearEditor() {
    await this.focusEditor();
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.cdpMethod("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(200);
  }
  async focusEditor() {
    const js = `(() => {
      ${VISIBLE_JS}
      ${DOCS_JS}
      const sels = ${JSON.stringify(["#m365-chat-editor-target-element", '[data-lexical-editor="true"][contenteditable]', '[role="textbox"][contenteditable]'])};
      for (const d of __docs) for (const s of sels) {
        const el = d.querySelector(s);
        if (__vis(el)) {
          try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
          try {
            const range = d.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = d.getSelection();
            if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          } catch (e) {}
          return 'ok';
        }
      }
      return 'ng';
    })()`;
    if (await this.evalWithReconnect(js) !== "ok") throw new Error("\u5165\u529B\u6B04\u306B\u30D5\u30A9\u30FC\u30AB\u30B9\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  async waitSendReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = { ready: false, inventory: [] };
    do {
      try {
        latest = JSON.parse(String(await this.evalWithReconnect(COPILOT_SEND_READY_JS)));
        if (latest.ready) return latest;
      } catch {
      }
      if (Date.now() < deadline) await sleep(150);
    } while (Date.now() < deadline);
    return latest;
  }
  async waitSendEstablished(baselineText, baselineInputLength, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let notReadySamples = 0;
    do {
      const state = await this.readScreenState(5e3);
      const inputLength = await this.editorLength();
      const ready = await this.waitSendReady(1);
      if (state.generating || baselineText && state.text && state.text !== baselineText || baselineInputLength > 0 && inputLength >= 0 && inputLength <= 2) return true;
      notReadySamples = ready.ready ? 0 : notReadySamples + 1;
      if (notReadySamples >= 2) return true;
      if (Date.now() < deadline) await sleep(150);
    } while (Date.now() < deadline);
    return false;
  }
  async clickSend(baselineText = "") {
    const ready = await this.waitSendReady(6e3);
    if (!ready.ready) {
      const diagnostic = JSON.stringify(ready.inventory ?? []).slice(0, 3e3);
      console.log(`[send] candidate inventory: ${diagnostic}`);
      throw new Error(`\u6709\u52B9\u306A\u9001\u4FE1\u30DC\u30BF\u30F3\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5019\u88DC\u8A3A\u65AD: ${diagnostic}`);
    }
    const baselineInputLength = await this.editorLength();
    const raw = await this.evalWithReconnect(COPILOT_CLICK_SEND_JS);
    const result = JSON.parse(String(raw));
    if (!result.clicked) {
      const diagnostic = JSON.stringify(result.inventory ?? []).slice(0, 3e3);
      console.log(`[send] candidate inventory: ${diagnostic}`);
      throw new Error(`\u6709\u52B9\u306A\u9001\u4FE1\u30DC\u30BF\u30F3\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5019\u88DC\u8A3A\u65AD: ${diagnostic}`);
    }
    if (await this.waitSendEstablished(baselineText, baselineInputLength, 1800)) return;
    const x = Number(result.selected?.rect?.cx);
    const y = Number(result.selected?.rect?.cy);
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      await this.cdpMethod("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(80);
      await this.cdpMethod("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      if (await this.waitSendEstablished(baselineText, baselineInputLength, 1800)) {
        console.log("[send] synthetic click\u672A\u6210\u7ACB\u306E\u305F\u3081CDP native mouse\u3067\u9001\u4FE1");
        return;
      }
    }
    throw new Error("\u9001\u4FE1\u30DC\u30BF\u30F3\u64CD\u4F5C\u5F8C\u3082\u751F\u6210\u958B\u59CB\u30FB\u5165\u529B\u6D88\u53BB\u30FB\u5FDC\u7B54\u5897\u52A0\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F");
  }
  async readScreenState(timeoutMs = 15e3) {
    const raw = await this.evalWithReconnect(COPILOT_SCREEN_STATE_JS, timeoutMs);
    const parsed = JSON.parse(String(raw));
    const latest = selectLatestResponseCandidate(parsed.responseCandidates ?? []);
    return {
      text: latest?.text ?? "",
      generating: (parsed.stopCandidates ?? []).some(isStopGenerationControl),
      copyEnabled: latest?.copyEnabled === true,
      signinRequired: parsed.signinRequired
    };
  }
  async waitResponse(baseline, signal) {
    const startedAt = Date.now();
    const deadline = Date.now() + this.s.responseTimeoutSec * 1e3;
    let lastText = "";
    let lastChange = Date.now();
    let sawNewText = false;
    let completionState = { stableText: null, stableSinceMs: null };
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const st = await this.readScreenState(Math.min(15e3, remainingMs));
      if (Date.now() >= deadline) break;
      if (st.signinRequired) throw new Error("Copilot \u3078\u306E\u30B5\u30A4\u30F3\u30A4\u30F3\u304C\u5FC5\u8981\u3067\u3059\u3002");
      if (st.text && st.text !== baseline) {
        sawNewText = true;
        if (st.text !== lastText) {
          lastText = st.text;
          lastChange = Date.now();
        }
      }
      const quietFor = Date.now() - lastChange;
      const completion = updateResponseCompletionState(completionState, {
        observedAtMs: Date.now(),
        text: sawNewText && st.text === lastText ? lastText : "",
        generating: st.generating,
        copyEnabled: st.copyEnabled
      });
      completionState = completion.state;
      if (completion.ready) {
        const completionReadyAt = Date.now();
        const visibleAnswer = this.cleanResponse(lastText);
        const answer = visibleAnswer || await this.finalizeAnswer(lastText, deadline);
        assertResponseDeadline(deadline, this.s.responseTimeoutSec);
        return {
          answer,
          generationWaitMs: completionReadyAt - startedAt,
          completionRetrievalMs: Date.now() - completionReadyAt
        };
      }
      if (!st.generating && sawNewText && quietFor > this.s.stallTimeoutSec * 1e3) {
        throw new Error("Copilot \u306E\u5FDC\u7B54\u304C\u505C\u6EDE\u3057\u305F\u305F\u3081\u8AE6\u3081\u307E\u3057\u305F");
      }
      const sleepMs = Math.min(this.s.pollIntervalMs, deadline - Date.now());
      if (sleepMs > 0) await sleep(sleepMs);
      throwIfAborted(signal);
    }
    throw new Error(`Copilot \u306E\u5FDC\u7B54\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F (${this.s.responseTimeoutSec}\u79D2)`);
  }
  cleanResponse(text) {
    return text.split("\n").filter((l) => l.trim() !== this.s.endMarker).join("\n").trim();
  }
  async selectModel() {
    if (!this.s.modelPriority || this.s.modelPriority.length === 0) return;
    const js = MODEL_SELECT_JS.replace("__CANDIDATES__", JSON.stringify(this.s.modelPriority)).replace("__SWITCHER__", JSON.stringify("#gptModeSwitcher"));
    try {
      const raw = await this.evalWithReconnect(js, 3e4);
      const r = JSON.parse(String(raw));
      if (r.changed) console.log(`[model] ${r.before ?? "?"} -> ${r.after ?? r.picked ?? "?"}`);
      else if (["switcher_not_found", "menu_not_found", "model_not_in_menu"].includes(r.reason ?? "")) console.warn(`[model] \u5229\u7528\u4E0D\u53EF\u306E\u305F\u3081UI\u65E2\u5B9A\u3092\u7D99\u7D9A: ${r.reason}`);
    } catch (err) {
      console.log(`[model] \u5207\u66FF\u30B9\u30AD\u30C3\u30D7(\u7D99\u7D9A): ${err.message}`);
    }
  }
  async complete(prompt, signal) {
    const totalStartedAt = Date.now();
    this.lastTiming = null;
    throwIfAborted(signal);
    let phaseStartedAt = Date.now();
    await this.ensureEdge();
    await this.ensurePage();
    const connectionMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.freshChat();
    const sessionCreationMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.waitInputReady(120, signal);
    if (this.visibleSessionId) {
      await this.stampVisibleSessionMarker(this.visibleSessionId);
      await this.bringToFront();
    }
    const inputReadyMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.selectModel();
    const modelSelectionMs = Date.now() - phaseStartedAt;
    throwIfAborted(signal);
    phaseStartedAt = Date.now();
    await this.waitInputReady(30, signal);
    await this.assertTrustedOrigin();
    const prePromptReadyMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.insertPrompt(prompt);
    const promptWriteMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    const baseline = (await this.readScreenState()).text;
    const baselineReadMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.clickSend(baseline);
    const sendMs = Date.now() - phaseStartedAt;
    throwIfAborted(signal);
    const response = await this.waitResponse(baseline, signal);
    this.lastTiming = {
      connectionMs,
      sessionCreationMs,
      inputReadyMs,
      modelSelectionMs,
      prePromptReadyMs,
      promptWriteMs,
      baselineReadMs,
      sendMs,
      generationWaitMs: response.generationWaitMs,
      completionRetrievalMs: response.completionRetrievalMs,
      totalMs: Date.now() - totalStartedAt,
      promptChars: prompt.length,
      responseChars: response.answer.length
    };
    console.log("[copilot-timing] " + JSON.stringify(this.lastTiming));
    return response.answer;
  }
  getLastTiming() {
    return this.lastTiming ? { ...this.lastTiming } : null;
  }
  close() {
    this.cdp?.close();
    this.cdp = null;
  }
};

// src/openai-bridge.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_http = __toESM(require("node:http"));

// src/converter.ts
var import_jsonrepair = __toESM(require_cjs());
function protocolObject(value, tools) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value;
  const keys = Object.keys(parsed);
  if (Object.prototype.hasOwnProperty.call(parsed, "AGENT_END") && parsed.AGENT_END !== true) return null;
  if (typeof parsed.answer === "string" && keys.every((key) => ["answer", "AGENT_END"].includes(key))) {
    return JSON.stringify({ answer: parsed.answer });
  }
  if (typeof parsed.tool !== "string") return null;
  const requested = parsed.tool.startsWith("host.") ? parsed.tool : `host.${parsed.tool}`;
  const matched = tools.find((tool) => tool.name === requested);
  if (!matched) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, "args")) {
    if (keys.some((key) => !["tool", "args", "AGENT_END"].includes(key))) return null;
    if (!parsed.args || typeof parsed.args !== "object" || Array.isArray(parsed.args)) return null;
    return JSON.stringify({ tool: matched.name, args: parsed.args });
  }
  const args = Object.fromEntries(Object.entries(parsed).filter(([key]) => !["tool", "AGENT_END"].includes(key)));
  return JSON.stringify({ tool: matched.name, args });
}
function scanJsonObjects(text) {
  const found = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        found.push({ text: text.slice(start, index + 1), position: start });
        start = index;
        break;
      }
    }
  }
  return found;
}
function closeTruncatedJson(text) {
  let inString = false;
  let escaped = false;
  const stack = [];
  let lastSafe = -1;
  let lastComma = -1;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastSafe = index;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0) stack.pop();
      lastSafe = index;
    } else if (ch === ",") {
      lastSafe = index;
      lastComma = index;
    }
  }
  if (!inString && stack.length === 0) return null;
  const cutAt = inString ? lastComma : lastSafe;
  if (cutAt < 0) return null;
  let closed = text.slice(0, cutAt).replace(/,\s*$/u, "");
  const remaining = [];
  let quoted = false;
  let slash = false;
  for (const ch of closed) {
    if (quoted) {
      if (slash) slash = false;
      else if (ch === "\\") slash = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") remaining.push(ch);
    else if ((ch === "}" || ch === "]") && remaining.length > 0) remaining.pop();
  }
  for (let index = remaining.length - 1; index >= 0; index--) closed += remaining[index] === "{" ? "}" : "]";
  return closed;
}
function repairJsonText(source) {
  let text = source;
  const repairs = [];
  let next = text.replace(/((?:"[^"\r\n]+"\s*:\s*))([「｢『【])/gu, '$1"$2');
  if (next !== text) {
    text = next;
    repairs.push("missing-open-quote");
  }
  const closed = closeTruncatedJson(text);
  if (closed !== null) {
    text = closed;
    repairs.push("truncated-tool-tail-drop");
  }
  return { text, repairs };
}
function repairWindowsPathBackslashes(source) {
  let changed = false;
  const repaired = source.replace(/(:\s*")([A-Za-z]:\\[^"\r\n]*)(")/gu, (_match, prefix, pathValue, suffix) => {
    const escaped = pathValue.replace(/\\+/gu, (slashes) => slashes.length % 2 === 0 ? slashes : `${slashes}\\`);
    if (escaped !== pathValue) changed = true;
    return prefix + escaped + suffix;
  });
  return changed ? repaired : null;
}
function jsonDecisionCandidates(rawResponse, tools) {
  const clean = rawResponse.replace(/<think>[\s\S]*?<\/think>/giu, "").replace(/```(?:json)?/giu, "").replace(/```/gu, "").replace(/\bAGENT_END\b/giu, "").trim();
  const sources = scanJsonObjects(clean).map((candidate) => ({ text: candidate.text, offset: candidate.position }));
  for (let position = clean.indexOf("{"); position >= 0; position = clean.indexOf("{", position + 1)) sources.push({ text: clean.slice(position), offset: position });
  const valid = [];
  const seen = /* @__PURE__ */ new Set();
  for (const source of sources) {
    const attempts = [{ text: source.text, repairs: [] }];
    try {
      const repaired = (0, import_jsonrepair.jsonrepair)(source.text);
      if (repaired !== source.text) attempts.push({ text: repaired, repairs: ["jsonrepair"] });
    } catch {
      const custom = repairJsonText(source.text);
      if (custom.repairs.length > 0) {
        try {
          attempts.push({ text: (0, import_jsonrepair.jsonrepair)(custom.text), repairs: [...custom.repairs, "jsonrepair"] });
        } catch {
        }
      }
    }
    const windowsPath = repairWindowsPathBackslashes(source.text);
    if (windowsPath !== null) {
      try {
        attempts.push({ text: (0, import_jsonrepair.jsonrepair)(windowsPath), repairs: ["windows-path-backslash", "jsonrepair"], semanticBonus: 40 });
      } catch {
      }
    }
    for (const attempt of attempts) {
      try {
        const content = protocolObject(JSON.parse(attempt.text), tools);
        if (!content) continue;
        const key = `${source.offset}:${content}:${attempt.repairs.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const score = /"(?:tool|answer)"/u.test(attempt.text) ? 20 : 0;
        valid.push({ text: content, position: source.offset, score: score + (/"args"/u.test(attempt.text) ? 8 : 0) + (attempt.semanticBonus ?? 0), repairs: attempt.repairs });
      } catch {
      }
    }
  }
  return valid.sort((a, b) => b.score - a.score || b.position - a.position || a.repairs.length - b.repairs.length);
}
function captureLabeledValue(raw, key) {
  const marker = new RegExp(`${key}\\s*(?:\u306F|=|:|\uFF1A)\\s*`, "iu").exec(raw);
  if (!marker) return void 0;
  let rest = raw.slice(marker.index + marker[0].length).trim();
  if (rest.startsWith("\u300C")) return rest.slice(1, rest.indexOf("\u300D") >= 0 ? rest.indexOf("\u300D") : void 0);
  if (rest.startsWith('"')) {
    try {
      return JSON.parse(rest.match(/^"(?:\\.|[^"\\])*"/u)?.[0] ?? "");
    } catch {
    }
  }
  if (rest.startsWith("[") || rest.startsWith("{")) {
    const candidate = rest.startsWith("{") ? scanJsonObjects(rest)[0]?.text : rest.match(/^\[[\s\S]*?\]/u)?.[0];
    try {
      if (candidate) return JSON.parse(candidate);
    } catch {
    }
  }
  rest = rest.split(/\s+\/\s+(?=[a-z_]+\s*=)/iu)[0].replace(/\s+(?:で呼びます|で呼ぶ|を使います|を使う|です)[。.!！]?\s*$/u, "").replace(/[。.!！]\s*$/u, "").trim();
  if (/^(?:true|false)$/iu.test(rest)) return rest.toLowerCase() === "true";
  if (/^-?\d+$/u.test(rest)) return Number(rest);
  return rest || void 0;
}
function explicitToolDecision(rawResponse, tools) {
  const text = rawResponse.trim();
  const negative = /(?:例[:：]|たとえば|例えば|今回は[^。\n]*(?:しません|しない)|拒否され|呼び出せません|まだ[^。\n]*(?:できません|呼べません)|操作しません)/u.test(text);
  if (negative) return null;
  const matched = [...tools].sort((a, b) => b.name.length - a.name.length).find((tool) => {
    const bare2 = tool.name.startsWith("host.") ? tool.name.slice(5) : tool.name;
    return text.toLowerCase().includes(tool.name.toLowerCase()) || text.toLowerCase().includes(bare2.toLowerCase());
  });
  if (!matched) return null;
  const argsLabel = /\bARGS?\b\s*[:：]?\s*/iu.exec(text);
  if (argsLabel) {
    const argsCandidate = scanJsonObjects(text.slice(argsLabel.index + argsLabel[0].length))[0];
    if (argsCandidate) {
      try {
        return JSON.stringify({ tool: matched.name, args: JSON.parse(argsCandidate.text) });
      } catch {
      }
    }
  }
  const bare = matched.name.startsWith("host.") ? matched.name.slice(5) : matched.name;
  if (bare === "write_file") {
    const naturalWrite = text.match(/(?:host\.)?write_file\s*で\s*([^\r\n]+?)\s*に「([\s\S]*?)」を新規作成/u);
    if (naturalWrite) return JSON.stringify({ tool: matched.name, args: { path: naturalWrite[1].trim(), content: naturalWrite[2] } });
  }
  const keysByTool = {
    list_files: ["path", "glob", "recursive"],
    read_file: ["path"],
    read_files: ["paths", "pattern"],
    read_xlsx: ["path"],
    search_files: ["query", "path", "glob", "max_results"],
    write_file: ["path", "content"],
    run_command: ["command"],
    start_process: ["command"]
  };
  const args = {};
  for (const key of keysByTool[bare] ?? []) {
    const value = captureLabeledValue(text, key);
    if (value !== void 0) args[key] = value;
  }
  if (Object.keys(args).length === 0 && !/(?:使|呼び|実行|取得|列挙|一覧)/u.test(text)) return null;
  return JSON.stringify({ tool: matched.name, args });
}
function interpretCopilotResponseDeterministically(rawResponse, tools) {
  const candidates = jsonDecisionCandidates(rawResponse, tools);
  const negativeContext = /(?:例[:：]|たとえば|例えば|今回は[^。\n]*(?:しません|しない)|操作しません|拒否され|呼び出せません)/u.test(rawResponse);
  if (candidates.length > 0 && !negativeContext) return { content: candidates[0].text, method: "json-candidate", repairs: candidates[0].repairs };
  const explicit = explicitToolDecision(rawResponse, tools);
  if (explicit) return { content: explicit, method: "explicit-tool-text", repairs: [] };
  const answer = rawResponse.replace(/<think>[\s\S]*?<\/think>/giu, "").replace(/```/gu, "").replace(/\bAGENT_END\b/giu, "").trim();
  if (!answer) return null;
  const mentionsAllowedTool = tools.some((tool) => {
    const bare = tool.name.startsWith("host.") ? tool.name.slice(5) : tool.name;
    return answer.toLowerCase().includes(tool.name.toLowerCase()) || answer.toLowerCase().includes(bare.toLowerCase());
  });
  if (mentionsAllowedTool && !negativeContext) return null;
  return { content: JSON.stringify({ answer }), method: "plain-answer", repairs: [] };
}

// src/openai-bridge.ts
var MAX_BODY_BYTES = 2 * 1024 * 1024;
var TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
var ANNOTATION_KEYWORDS = /* @__PURE__ */ new Set(["description", "title", "default", "examples", "deprecated", "readOnly", "writeOnly", "$comment", "$schema", "$id", "$defs", "definitions"]);
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function messageContent(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0) return "";
  if (!Array.isArray(value)) throw new Error("message.content \u306F\u6587\u5B57\u5217\u307E\u305F\u306Ftext part\u914D\u5217\u3060\u3051\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u3059");
  return value.map((part) => {
    if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") {
      throw new Error("\u753B\u50CF\u30FB\u97F3\u58F0\u306A\u3069text\u4EE5\u5916\u306Emessage content part\u306F\u672A\u5BFE\u5FDC\u3067\u3059");
    }
    return part.text;
  }).join("\n");
}
function assertTools(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error("tools \u306F128\u4EF6\u4EE5\u4E0B\u306E\u914D\u5217\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const seen = /* @__PURE__ */ new Set();
  return value.map((candidate) => {
    if (!isObject(candidate) || candidate.type !== "function" || !isObject(candidate.function)) throw new Error("function tool\u4EE5\u5916\u306F\u672A\u5BFE\u5FDC\u3067\u3059");
    const name = candidate.function.name;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) throw new Error(`tool\u540D\u304C\u4E0D\u6B63\u3067\u3059: ${String(name ?? "")}`);
    if (seen.has(name)) throw new Error(`tool\u540D\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059: ${name}`);
    seen.add(name);
    const description = candidate.function.description;
    if (description !== void 0 && typeof description !== "string") throw new Error(`tool description\u304C\u4E0D\u6B63\u3067\u3059: ${name}`);
    const parameters = candidate.function.parameters ?? { type: "object", properties: {} };
    if (!isObject(parameters)) throw new Error(`tool parameters\u304C\u4E0D\u6B63\u3067\u3059: ${name}`);
    return { type: "function", function: { name, description, parameters } };
  });
}
function parseOpenAIChatRequest(value) {
  if (!isObject(value)) throw new Error("request body\u306FJSON object\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 200) throw new Error("messages \u306F1\u301C200\u4EF6\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  const messages = value.messages.map((candidate) => {
    if (!isObject(candidate) || !["system", "user", "assistant", "tool"].includes(String(candidate.role ?? ""))) throw new Error("message.role\u304C\u4E0D\u6B63\u3067\u3059");
    messageContent(candidate.content);
    return candidate;
  });
  const stream = value.stream;
  if (stream !== void 0 && typeof stream !== "boolean") throw new Error("stream \u306Fboolean\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  return {
    model: typeof value.model === "string" ? value.model : void 0,
    messages,
    tools: assertTools(value.tools),
    tool_choice: value.tool_choice,
    stream
  };
}
function buildBridgePrompt(request) {
  const transcript = request.messages.map((message, index) => {
    const meta = [message.name ? `name=${message.name}` : "", message.tool_call_id ? `tool_call_id=${message.tool_call_id}` : ""].filter(Boolean).join(" ");
    const calls = message.tool_calls === void 0 ? "" : `
tool_calls=${JSON.stringify(message.tool_calls)}`;
    return `[${index + 1}:${message.role.toUpperCase()}${meta ? ` ${meta}` : ""}]
${messageContent(message.content)}${calls}`;
  }).join("\n\n");
  if (!request.tools?.length) return [
    "\u4EE5\u4E0B\u306E\u4F1A\u8A71\u306B\u5BFE\u3059\u308B\u6B21\u306Eassistant\u56DE\u7B54\u3092\u751F\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u7C21\u6F54\u306B\u7B54\u3048\u3066\u304F\u3060\u3055\u3044\u3002",
    transcript
  ].join("\n\n");
  const tools = request.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters ?? { type: "object", properties: {} }
  }));
  return [
    "\u4EE5\u4E0B\u306E\u4F1A\u8A71\u306B\u5BFE\u3059\u308B\u6B21\u306Eassistant\u306E1\u624B\u3060\u3051\u3092\u751F\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    '\u5229\u7528\u53EF\u80FD\u306A\u95A2\u6570\u304C\u5FC5\u8981\u306A\u3089\u3001\u5730\u306E\u6587\u3092\u4ED8\u3051\u305A JSON 1\u500B\u3060\u3051\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044: {"tool":"\u95A2\u6570\u540D","args":{...}}',
    "\u95A2\u6570\u304C\u4E0D\u8981\u306A\u3089\u901A\u5E38\u306E\u56DE\u7B54\u3060\u3051\u3092\u8FD4\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u5024\u30FB\u30D1\u30B9\u30FB\u4E8B\u5B9F\u3092\u63A8\u6E2C\u3057\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002\u4E26\u5217\u95A2\u6570\u547C\u3073\u51FA\u3057\u306F\u3057\u307E\u305B\u3093\u3002",
    "\u5229\u7528\u8005\u306E\u300C\u3053\u3053\u300D\u300C\u3053\u306E\u5834\u6240\u300D\u300C\u76F4\u4E0B\u300D\u306F\u30DB\u30B9\u30C8\u306E\u73FE\u5728\u306E\u4F5C\u696D\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3092\u6307\u3057\u307E\u3059\u3002\u95A2\u6570\u304C\u76F8\u5BFE\u30D1\u30B9\u3092\u8A31\u3059\u5834\u5408\u306F\u3001\u305D\u306E\u57FA\u6E96\u3092\u8868\u3059 . \u3092\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
    "\u5229\u7528\u8005\u304C\u30D5\u30A1\u30A4\u30EB\u3092\u300C\u958B\u304F\u300D\u3068\u983C\u3093\u3060\u5834\u5408\u306F\u5185\u5BB9\u306E\u8AAD\u307F\u53D6\u308A\u3067\u4EE3\u7528\u305B\u305A\u3001\u5229\u7528\u53EF\u80FD\u306A\u30B3\u30DE\u30F3\u30C9\u5B9F\u884C\u95A2\u6570\u3067\u65E2\u5B9A\u30A2\u30D7\u30EA\u3092\u8D77\u52D5\u3059\u308B1\u624B\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002",
    "\u65B0\u898F\u30D5\u30A1\u30A4\u30EB\u306E\u89AA\u30D5\u30A9\u30EB\u30C0\u3068\u540D\u524D\u304C\u5229\u7528\u8005\u306E\u4F9D\u983C\u304B\u3089\u4E00\u610F\u306A\u3089\u3001\u89AA\u30D5\u30A9\u30EB\u30C0\u3092\u691C\u7D22\u305B\u305A\u3001\u6307\u5B9A\u3092\u76F8\u5BFE\u30D1\u30B9\u3078\u5FE0\u5B9F\u306B\u7D44\u307F\u7ACB\u3066\u3066\u66F8\u304D\u8FBC\u307F\u95A2\u6570\u3092\u547C\u3093\u3067\u304F\u3060\u3055\u3044\u3002",
    `AVAILABLE_FUNCTIONS=${JSON.stringify(tools)}`,
    transcript
  ].join("\n\n");
}
function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
function validateSchema(value, schema, at = "$") {
  if (schema === true || schema === void 0) return { ok: true };
  if (schema === false || !isObject(schema)) return { ok: false, error: `${at}: unsupported schema` };
  if ("$ref" in schema || "patternProperties" in schema || "not" in schema || "if" in schema || "then" in schema || "else" in schema) {
    return { ok: false, error: `${at}: unsupported schema keyword` };
  }
  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) {
      const result = validateSchema(value, item, at);
      if (!result.ok) return result;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((item) => validateSchema(value, item, at));
    if (!results.some((result) => result.ok)) return { ok: false, error: `${at}: anyOf mismatch` };
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.filter((item) => validateSchema(value, item, at).ok).length !== 1) return { ok: false, error: `${at}: oneOf mismatch` };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return { ok: false, error: `${at}: enum mismatch` };
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return { ok: false, error: `${at}: const mismatch` };
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => typeof type === "string" && matchesType(value, type))) return { ok: false, error: `${at}: type mismatch` };
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return { ok: false, error: `${at}: minLength` };
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return { ok: false, error: `${at}: maxLength` };
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return { ok: false, error: `${at}: pattern` };
      } catch {
        return { ok: false, error: `${at}: invalid pattern` };
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return { ok: false, error: `${at}: minimum` };
    if (typeof schema.maximum === "number" && value > schema.maximum) return { ok: false, error: `${at}: maximum` };
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return { ok: false, error: `${at}: minItems` };
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return { ok: false, error: `${at}: maxItems` };
    if (schema.items !== void 0) {
      for (let index = 0; index < value.length; index++) {
        const result = validateSchema(value[index], schema.items, `${at}[${index}]`);
        if (!result.ok) return result;
      }
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) if (typeof key !== "string" || !(key in value)) return { ok: false, error: `${at}: missing ${String(key)}` };
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        const result = validateSchema(item, properties[key], `${at}.${key}`);
        if (!result.ok) return result;
      } else if (schema.additionalProperties === false) {
        return { ok: false, error: `${at}: additional property ${key}` };
      } else if (isObject(schema.additionalProperties)) {
        const result = validateSchema(item, schema.additionalProperties, `${at}.${key}`);
        if (!result.ok) return result;
      }
    }
  }
  for (const key of Object.keys(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    if (!["type", "properties", "required", "additionalProperties", "items", "enum", "const", "allOf", "anyOf", "oneOf", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems"].includes(key)) {
      return { ok: false, error: `${at}: unsupported schema keyword ${key}` };
    }
  }
  return { ok: true };
}
function converterTools(tools) {
  return tools.map((tool) => ({
    name: `host.${tool.function.name}`,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters ?? { type: "object", properties: {} }
  }));
}
function interpretBridgeResponse(raw, tools) {
  const deterministic = interpretCopilotResponseDeterministically(raw, converterTools(tools));
  if (!deterministic) return { content: raw, method: "raw-fallback", repairs: [] };
  let decision;
  try {
    decision = JSON.parse(deterministic.content);
  } catch {
    return { content: raw, method: "raw-fallback", repairs: [] };
  }
  if (typeof decision.answer === "string") return { content: decision.answer, method: deterministic.method, repairs: deterministic.repairs };
  if (typeof decision.tool !== "string" || !isObject(decision.args)) return { content: raw, method: "raw-fallback", repairs: [] };
  const externalName = decision.tool.startsWith("host.") ? decision.tool.slice(5) : decision.tool;
  const matched = tools.find((tool) => tool.function.name === externalName);
  if (!matched) return { content: raw, method: "raw-fallback", repairs: [] };
  const validation = validateSchema(decision.args, matched.function.parameters ?? { type: "object", properties: {} });
  if (!validation.ok) return { content: raw, method: "schema-rejected", repairs: deterministic.repairs, diagnostic: validation.error };
  return {
    content: null,
    toolCalls: [{
      id: `call_${import_node_crypto.default.randomBytes(12).toString("hex")}`,
      type: "function",
      function: { name: externalName, arguments: JSON.stringify(decision.args) }
    }],
    method: deterministic.method,
    repairs: deterministic.repairs
  };
}
async function completeOpenAIChat(request, options, signal) {
  const raw = await options.complete(buildBridgePrompt(request), signal);
  const interpreted = interpretBridgeResponse(raw, request.tools ?? []);
  console.log("[bridge-decision] " + JSON.stringify({
    interpretation: interpreted.method,
    repairs: interpreted.repairs,
    tool: interpreted.toolCalls?.[0]?.function && isObject(interpreted.toolCalls[0].function) ? interpreted.toolCalls[0].function.name : null,
    diagnostic: interpreted.diagnostic ?? null,
    toolCount: request.tools?.length ?? 0
  }));
  const created = Math.floor((options.now?.() ?? Date.now()) / 1e3);
  const toolCalls = interpreted.toolCalls;
  return {
    id: `chatcmpl_${import_node_crypto.default.randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created,
    model: request.model ?? "copilot-edge-layer1",
    choices: [{
      index: 0,
      message: toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: interpreted.content ?? "" },
      finish_reason: toolCalls ? "tool_calls" : "stop"
    }],
    bridge: { interpretation: interpreted.method, repairs: interpreted.repairs }
  };
}
function authorized(header, token2) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(token2, "utf8");
  return supplied.length === expected.length && import_node_crypto.default.timingSafeEqual(supplied, expected);
}
function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
function sendSingleChunkSse(response, completion) {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const first = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(first.message) ? first.message : {};
  const id = String(completion.id ?? `chatcmpl_${import_node_crypto.default.randomBytes(12).toString("hex")}`);
  const created = Number(completion.created ?? Math.floor(Date.now() / 1e3));
  const model = String(completion.model ?? "copilot-edge-layer1");
  const delta = { role: "assistant" };
  if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...isObject(call) ? call : {} }));
  else delta.content = typeof message.content === "string" ? message.content : "";
  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: String(first.finish_reason ?? "stop") }] }
  ];
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}

`);
  response.end("data: [DONE]\n\n");
}
function openAIError(response, status, message, code) {
  sendJson(response, status, { error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", param: null, code } });
}
async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body\u304C2MB\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function createOpenAICompatibleBridgeServer(token2, options) {
  if (token2.length < 16) throw new Error("COPILOT_BRIDGE_TOKEN \u306F16\u6587\u5B57\u4EE5\u4E0A\u3067\u56FA\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044");
  let queue = Promise.resolve();
  const schedule = (work) => {
    const next = queue.then(work, work);
    queue = next.then(() => void 0, () => void 0);
    return next;
  };
  return import_node_http.default.createServer(async (request, response) => {
    if (!authorized(request.headers.authorization, token2)) return openAIError(response, 401, "Bearer token\u304C\u4E0D\u6B63\u3067\u3059", "invalid_api_key");
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return openAIError(response, 404, "POST /v1/chat/completions \u3060\u3051\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u3059", "not_found");
    try {
      const parsed = parseOpenAIChatRequest(await readJsonBody(request));
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      const result = await schedule(() => completeOpenAIChat(parsed, options, controller.signal));
      if (parsed.stream === true) sendSingleChunkSse(response, result);
      else sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof SyntaxError ? "request body\u304C\u6B63\u3057\u3044JSON\u3067\u306F\u3042\u308A\u307E\u305B\u3093" : error.message;
      openAIError(response, error instanceof SyntaxError ? 400 : 422, message, "bridge_request_failed");
    }
  });
}

// src/openai-bridge-server.ts
function argument(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : void 0;
}
var token = String(process.env.COPILOT_BRIDGE_TOKEN ?? "").trim();
var port = Number(argument("--port") ?? process.env.COPILOT_BRIDGE_PORT ?? 3952);
var cfg = loadConfig(argument("--config"));
if (cfg.provider !== "copilot-edge") throw new Error("bridge config\u306Fprovider=copilot-edge\u3060\u3051\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u3059");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("bridge port\u304C\u4E0D\u6B63\u3067\u3059");
var client = new CopilotEdgeClient(cfg);
var server = createOpenAICompatibleBridgeServer(token, { complete: (prompt, signal) => client.complete(prompt, signal) });
server.listen(port, "127.0.0.1", () => console.log(`copilot-openai-bridge listening on http://127.0.0.1:${port}/v1`));
var close = () => {
  server.close(() => {
    client.close();
    process.exit(0);
  });
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
