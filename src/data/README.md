# SQL Keywords

This directory contains the SQL keywords for the different dialects. Keywords are stored here so they can be lazily loaded.

## Structure

By default, we use the `SqlKeywordInfo` type to define the keywords.

```json
{
  "keyword": {
    "description": "Description of the keyword",
    "syntax": "Syntax of the keyword",
    "example": "Example of the keyword",
    "metadata": {
      "tag1": "value1",
      "tag2": "value2"
    }
  }
}
```
