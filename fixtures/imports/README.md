# Import fixtures

- `contacts-valid.csv`: five rows exercising international and national (Pakistan) numbers, exact age with reference date, age bands, groups/tags lists and per-row consent evidence.
- `contacts-invalid.csv`: intentional validation errors (empty name, missing/invalid/scientific-notation phone, conflicting age vs. band, out-of-range age, unknown gender, in-file duplicate, formula-looking name).
- There are no checked-in XLSX files: the XLSX tests build their workbooks in code with `buildXlsx` (`apps/api/src/__integration__/contacts.int-spec.ts`, `libs/domain/src/lib/__tests__/spreadsheet.spec.ts`), including a workbook with a formula cell that must be rejected.

Phone numbers here are synthetic and must never be used with a live provider.
