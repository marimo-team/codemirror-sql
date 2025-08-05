# SQL Keywords

This directory contains the SQL keywords for the different dialects. Keywords are stored here so they can be lazily loaded.

## Structure

By default, we use the `SqlKeywordInfo` type to define the keywords.

```json
{
  "keywords": {
    "keyword1": {
      "description": "Description of the keyword",
      "syntax": "Syntax of the keyword",
      "example": "Example of the keyword",
      "metadata": {
        "tag1": "value1",
        "tag2": "value2"
      }
    },
    "keyword2": {
      "description": "Description of the keyword",
      "syntax": "Syntax of the keyword",
      "example": "Example of the keyword",
      "metadata": {
        "tag1": "value1",
        "tag2": "value2"
      }
    }
  }
}
```

## Adding a new dialect

For compatibility with Vite and other bundlers, `import` returns a JS module and not a JSON object

So we need to nest the keywords under a json key to access them,
otherwise a keyword can conflict with a JS reserved keyword (e.g. `default` or `with`)
