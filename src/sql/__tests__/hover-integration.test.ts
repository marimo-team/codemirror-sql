import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { describe, expect, it, vi } from "vitest";
import { sqlHover, sqlHoverTheme } from "../hover.js";
import { resolveNamespaceItem } from "../namespace-utils.js";

// Helper function to create completion objects
function createCompletion(label: string, detail?: string): Completion {
  return {
    label,
    detail: detail || `${label} completion`,
    type: "property",
  };
}

// Test namespace with various structures
const testNamespace: SQLNamespace = {
  // Simple database with tables and columns
  postgres: {
    self: createCompletion("postgres", "PostgreSQL database"),
    children: {
      public: {
        users: {
          self: createCompletion("users", "User table"),
          children: [
            createCompletion("id", "Primary key"),
            createCompletion("username", "Username"),
            createCompletion("email", "Email address"),
            "created_at",
            "updated_at",
          ],
        },
        orders: [
          createCompletion("id"),
          createCompletion("user_id"),
          createCompletion("total"),
          "status",
          "created_at",
        ],
      },
      analytics: {
        user_stats: ["daily_active", "monthly_active", "retention_rate"],
        sales_data: {
          q1_2024: ["january", "february", "march"],
          q2_2024: ["april", "may", "june"],
        },
      },
    },
  },
  // Simple object namespace
  mysql: {
    test_db: {
      customers: ["customer_id", "company_name", "contact_name"],
      products: {
        categories: [createCompletion("category_id"), createCompletion("category_name")],
      },
    },
  },
};

describe("Hover Integration Tests", () => {
  describe("Extension creation", () => {
    it("should create hover extension without errors", () => {
      expect(() => {
        sqlHover({
          schema: testNamespace,
          enableKeywords: true,
          enableTables: true,
          enableColumns: true,
        });
      }).not.toThrow();
    });

    it("should create hover theme without errors", () => {
      expect(() => {
        sqlHoverTheme();
      }).not.toThrow();
    });

    it("should handle empty configuration", () => {
      expect(() => {
        sqlHover();
      }).not.toThrow();
    });

    it("should handle function-based schema configuration", () => {
      expect(() => {
        sqlHover({
          schema: () => testNamespace,
        });
      }).not.toThrow();
    });
  });

  describe("Namespace resolution integration", () => {
    it("should resolve exact namespace paths with correct semantic types", () => {
      const result = resolveNamespaceItem(testNamespace, "postgres.public.users");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.semanticType).toBe("table");
      expect(result?.completion?.label).toBe("users");
      expect(result?.path).toEqual(["postgres", "public", "users"]);
    });

    it("should handle self-children namespace structures with database semantic type", () => {
      const result = resolveNamespaceItem(testNamespace, "postgres");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.semanticType).toBe("database");
      expect(result?.completion?.label).toBe("postgres");
    });

    it("should classify schemas correctly", () => {
      const result = resolveNamespaceItem(testNamespace, "postgres.public");
      expect(result).toBeTruthy();
      expect(result?.semanticType).toBe("schema");
      expect(result?.path).toEqual(["postgres", "public"]);
    });

    it("should handle array namespace structures as tables", () => {
      const result = resolveNamespaceItem(testNamespace, "postgres.public.orders");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.semanticType).toBe("table");
      expect(result?.path).toEqual(["postgres", "public", "orders"]);
    });

    it("should handle deeply nested namespace paths", () => {
      const result = resolveNamespaceItem(testNamespace, "postgres.analytics.sales_data.q1_2024");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.semanticType).toBe("table");
      expect(result?.path).toEqual(["postgres", "analytics", "sales_data", "q1_2024"]);
    });

    it("should resolve individual columns with column semantic type", () => {
      const result = resolveNamespaceItem(testNamespace, "id", { enableFuzzySearch: true });
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.semanticType).toBe("column");
      expect(result?.completion?.label).toBe("id");
    });

    it("should resolve string columns with column semantic type", () => {
      const result = resolveNamespaceItem(testNamespace, "created_at", { enableFuzzySearch: true });
      expect(result).toBeTruthy();
      expect(result?.type).toBe("string");
      expect(result?.semanticType).toBe("column");
      expect(result?.value).toBe("created_at");
    });
  });

  describe("Preference order testing", () => {
    it("should prefer exact namespace matches", () => {
      // Create a namespace that has a name conflicting with a SQL keyword
      const conflictNamespace: SQLNamespace = {
        select: {
          self: createCompletion("select", "Custom select table"),
          children: ["id", "name", "value"],
        },
      };

      const result = resolveNamespaceItem(conflictNamespace, "select");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.semanticType).toBe("table");
      expect(result?.completion?.label).toBe("select");
      expect(result?.completion?.detail).toBe("Custom select table");
    });

    it("should return null when no match found", () => {
      const result = resolveNamespaceItem(testNamespace, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("Dynamic nesting support", () => {
    it("should support variable depth namespace paths", () => {
      const deepNamespace: SQLNamespace = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: ["final_column"],
              },
            },
          },
        },
      };

      const result = resolveNamespaceItem(deepNamespace, "level1.level2.level3.level4.level5");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.path).toEqual(["level1", "level2", "level3", "level4", "level5"]);
    });

    it("should handle mixed namespace types in same path", () => {
      const mixedNamespace: SQLNamespace = {
        db: {
          self: createCompletion("db", "Database"),
          children: {
            schema: {
              table: [createCompletion("col1"), "col2", createCompletion("col3")],
            },
          },
        },
      };

      const result = resolveNamespaceItem(mixedNamespace, "db.schema.table");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.path).toEqual(["db", "schema", "table"]);
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle empty namespace gracefully", () => {
      expect(() => {
        resolveNamespaceItem({}, "anything");
      }).not.toThrow();

      const result = resolveNamespaceItem({}, "anything");
      expect(result).toBeNull();
    });

    it("should handle malformed paths gracefully", () => {
      expect(() => {
        resolveNamespaceItem(testNamespace, "..invalid.path..");
      }).not.toThrow();

      const result = resolveNamespaceItem(testNamespace, "..invalid.path..");
      expect(result).toBeNull();
    });

    it("should handle very long paths gracefully", () => {
      const longPath = `${"a.".repeat(20)}final`;
      expect(() => {
        resolveNamespaceItem(testNamespace, longPath);
      }).not.toThrow();

      const result = resolveNamespaceItem(testNamespace, longPath);
      expect(result).toBeNull();
    });
  });

  describe("Case sensitivity", () => {
    it("should handle case-insensitive matching by default", () => {
      const result = resolveNamespaceItem(testNamespace, "POSTGRES.PUBLIC.USERS");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.completion?.label).toBe("users");
    });

    it("should support mixed case in namespace paths", () => {
      const mixedCaseNamespace: SQLNamespace = {
        MyDatabase: {
          MySchema: {
            MyTable: ["MyColumn", "AnotherColumn"],
          },
        },
      };

      const result = resolveNamespaceItem(mixedCaseNamespace, "mydatabase.myschema.mytable");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.path).toEqual(["MyDatabase", "MySchema", "MyTable"]);
    });
  });
});

describe("Complex Namespace Scenarios", () => {
  it("should correctly resolve complex namespace structures", () => {
    const complexNamespace: SQLNamespace = {
      warehouse: {
        self: createCompletion("warehouse", "Data warehouse"),
        children: {
          raw: {
            events: [
              createCompletion("event_id", "Event identifier"),
              createCompletion("user_id", "User identifier"),
              createCompletion("timestamp", "Event timestamp"),
              "event_type",
              "properties",
            ],
            users: {
              self: createCompletion("users", "Raw user data"),
              children: [
                createCompletion("id", "User ID"),
                "username",
                "email",
                createCompletion("signup_date", "User signup date"),
              ],
            },
          },
          processed: {
            daily_stats: ["date", "active_users", "total_events", "revenue"],
            user_segments: {
              high_value: ["user_id", "ltv", "segment_date"],
              churned: ["user_id", "churn_date", "churn_reason"],
            },
          },
        },
      },
    };

    // Test various resolution scenarios with semantic types
    const warehouseResult = resolveNamespaceItem(complexNamespace, "warehouse");
    expect(warehouseResult?.type).toBe("completion");
    expect(warehouseResult?.semanticType).toBe("database");
    expect(warehouseResult?.completion?.label).toBe("warehouse");

    const rawResult = resolveNamespaceItem(complexNamespace, "warehouse.raw");
    expect(rawResult?.semanticType).toBe("schema");
    expect(rawResult?.path).toEqual(["warehouse", "raw"]);

    const eventsResult = resolveNamespaceItem(complexNamespace, "warehouse.raw.events");
    expect(eventsResult?.type).toBe("namespace");
    expect(eventsResult?.semanticType).toBe("table");
    expect(eventsResult?.path).toEqual(["warehouse", "raw", "events"]);

    const usersResult = resolveNamespaceItem(complexNamespace, "warehouse.raw.users");
    expect(usersResult?.type).toBe("completion");
    expect(usersResult?.semanticType).toBe("table");
    expect(usersResult?.completion?.label).toBe("users");

    const columnResult = resolveNamespaceItem(complexNamespace, "event_id", {
      enableFuzzySearch: true,
    });
    expect(columnResult?.type).toBe("completion");
    expect(columnResult?.semanticType).toBe("column");
    expect(columnResult?.completion?.label).toBe("event_id");

    const stringColumnResult = resolveNamespaceItem(complexNamespace, "username", {
      enableFuzzySearch: true,
    });
    expect(stringColumnResult?.type).toBe("string");
    expect(stringColumnResult?.semanticType).toBe("column");
    expect(stringColumnResult?.value).toBe("username");
  });
});

describe("Custom Tooltip Renderers", () => {
  const mockSchema: SQLNamespace = {
    users: {
      self: createCompletion("users", "User table"),
      children: [
        createCompletion("id", "Primary key"),
        createCompletion("name", "User name"),
        "email",
      ],
    },
    products: [createCompletion("product_id", "Product identifier"), "title", "price"],
  };

  describe("Keyword renderer", () => {
    it("should use custom keyword renderer when provided", () => {
      const customKeywordRenderer = vi.fn().mockReturnValue("<div>Custom keyword tooltip</div>");

      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            keyword: customKeywordRenderer,
          },
        });
      }).not.toThrow();

      // Since we can't easily trigger hover in tests, we just verify no errors occur
      expect(customKeywordRenderer).not.toHaveBeenCalled(); // Not called in setup
    });

    it("should fallback to default keyword renderer when custom renderer not provided", () => {
      expect(() => {
        sqlHover({
          schema: mockSchema,
          // No custom keyword renderer
        });
      }).not.toThrow();
    });
  });

  describe("Namespace renderer", () => {
    it("should use custom namespace renderer for database items", () => {
      const customNamespaceRenderer = vi
        .fn()
        .mockReturnValue("<div>Custom namespace tooltip</div>");

      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            namespace: customNamespaceRenderer,
          },
        });
      }).not.toThrow();
    });

    it("should handle namespace renderer data structure correctly", () => {
      // Test the data structure that would be passed to namespace renderer
      const result = resolveNamespaceItem(mockSchema, "users");
      expect(result).toBeTruthy();
      expect(result?.semanticType).toBe("table");

      // Verify data structure for namespace renderer
      expect(result).toBeTruthy();
      const namespaceData = {
        item: result,
        word: "users",
        resolvedSchema: mockSchema,
      };

      expect(namespaceData.item?.semanticType).toBe("table");
      expect(namespaceData.word).toBe("users");
      expect(namespaceData.resolvedSchema).toBe(mockSchema);
    });
  });

  describe("Table renderer", () => {
    it("should use custom table renderer for table items", () => {
      const customTableRenderer = vi.fn().mockReturnValue("<div>Custom table tooltip</div>");

      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            table: customTableRenderer,
          },
        });
      }).not.toThrow();
    });

    it("should handle table renderer data structure correctly", () => {
      const result = resolveNamespaceItem(mockSchema, "users");
      expect(result).toBeTruthy();
      expect(result?.semanticType).toBe("table");

      // Verify this would be passed to table renderer
      const tableData = {
        item: result,
        word: "users",
        resolvedSchema: mockSchema,
      };

      expect(tableData.item?.completion?.label).toBe("users");
      expect(tableData.item?.namespace).toBeDefined();
    });
  });

  describe("Column renderer", () => {
    it("should use custom column renderer for column items", () => {
      const customColumnRenderer = vi.fn().mockReturnValue("<div>Custom column tooltip</div>");

      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            column: customColumnRenderer,
          },
        });
      }).not.toThrow();
    });

    it("should handle column renderer data structure correctly", () => {
      const result = resolveNamespaceItem(mockSchema, "id", { enableFuzzySearch: true });
      expect(result).toBeTruthy();
      expect(result?.semanticType).toBe("column");

      // Verify data structure for column renderer
      const columnData = {
        item: result,
        word: "id",
        resolvedSchema: mockSchema,
      };

      expect(columnData.item?.completion?.label).toBe("id");
      expect(columnData.item?.semanticType).toBe("column");
    });
  });

  describe("Multiple custom renderers", () => {
    it("should handle multiple custom renderers simultaneously", () => {
      const customKeywordRenderer = vi.fn().mockReturnValue("<div>Custom keyword</div>");
      const customTableRenderer = vi.fn().mockReturnValue("<div>Custom table</div>");
      const customColumnRenderer = vi.fn().mockReturnValue("<div>Custom column</div>");
      const customNamespaceRenderer = vi.fn().mockReturnValue("<div>Custom namespace</div>");

      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            keyword: customKeywordRenderer,
            table: customTableRenderer,
            column: customColumnRenderer,
            namespace: customNamespaceRenderer,
          },
        });
      }).not.toThrow();
    });
  });

  describe("Fallback behavior", () => {
    it("should fallback to default renderer when custom renderer is not provided for specific type", () => {
      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {
            // Only provide keyword renderer, others should fallback
            keyword: () => "<div>Custom keyword</div>",
          },
        });
      }).not.toThrow();
    });

    it("should work with empty tooltipRenderers object", () => {
      expect(() => {
        sqlHover({
          schema: mockSchema,
          tooltipRenderers: {},
        });
      }).not.toThrow();
    });

    it("should work without tooltipRenderers option", () => {
      expect(() => {
        sqlHover({
          schema: mockSchema,
          // No tooltipRenderers specified
        });
      }).not.toThrow();
    });
  });
});
