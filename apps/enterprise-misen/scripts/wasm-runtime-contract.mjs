// WebAssembly modules allowed inside a prepared runtime (Issue #138). Misen ships no native
// addon and no DLL beyond the approved Node.js and OfficeCLI executables; the PDF capability
// runs pdf.js (pure JS plus its image-decoder wasm) and PDFium compiled to wasm instead.
export const allowedWasmDirectories = Object.freeze([
  'app/node_modules/pdfjs-dist/wasm/',
  'app/node_modules/@hyzyla/pdfium/dist/',
])
