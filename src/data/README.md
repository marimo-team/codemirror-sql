# Generating SQL Dialects and Keywords

Dialects enable CodeMirror to provide SQL syntax highlighting.

Keywords allow CodeMirror to offer SQL autocompletion and display hover tooltips.

| Database | How to Run Spec Script                  |
| -------- | --------------------------------------- |
| DuckDB   | `python src/data/duckdb/spec_duckdb.py` |

> 💡 **Tip:** Update the script path to match your target SQL dialect.  
> Running the script will automatically generate the keywords and types for the corresponding `*.ts` dialect file.

> 🚀 **Quick Start:**  
> To open and run the script interactively in marimo, use:  
> `uvx marimo edit <path-to-script>`
