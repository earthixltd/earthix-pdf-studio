# PDF Compatibility Report

## Regression document

The test document supplied in the conversation is a 21-page PDF 1.5 linearized document. It uses a first-section `startxref 0` marker and a final xref-stream offset. The final xref stream uses `/W [1 3 1]`, `/Index [115 55]`, `/Prev`, `/FlateDecode` and PNG Predictor 12. The file also contains compressed indirect objects in `/ObjStm` streams and mixed font encodings.

## Current result

| Check | Result |
|---|---:|
| PDF version | 1.5 |
| Linearized | Yes |
| `startxref` offsets | 0, 116 |
| XRef stream objects | 2 |
| Object stream objects | 25 |
| Pages | 21 |
| Font resources | 10 |
| Font encodings | Identity-H, WinAnsiEncoding |
| Native text runs | 1,558 |
| Replaceable runs | 1,558 |
| Native replacement test | Passed |
| Export/reopen text check | Passed |

The replacement test changed `What is a computer Network?` to `What is a computer Network!` using the native text content stream. The original string was absent from exported text extraction and the replacement string remained searchable. The page count and PDF version remained unchanged.

## Reproduction

```bash
npm run diagnose:pdf -- "C:\\path\\to\\What-is-a-computer-Network(1).pdf"
```

The supplied PDF is not included in the repository or release ZIP.

## Known limitations

This report covers the supplied xref-stream structure only. It is not a claim of full PDF specification compatibility. Encrypted files, unusual filters, certain predictors, nested Form XObjects, unsupported encodings, missing glyphs, signed documents and malformed structures need separate handling and regression fixtures.
