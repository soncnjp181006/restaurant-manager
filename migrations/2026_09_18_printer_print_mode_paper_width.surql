-- Printer: make deprecated `prints` optional; add per-printer print_mode and
-- paper_width_mm overrides (match src/api/model/printer.ts).
-- Empty/null print_mode / paper_width_mm = inherit from print-type settings.

DEFINE FIELD OVERWRITE prints ON printer TYPE option<int|null> PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS print_mode ON printer TYPE option<string|null> PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS paper_width_mm ON printer TYPE option<int|null> PERMISSIONS FULL;
