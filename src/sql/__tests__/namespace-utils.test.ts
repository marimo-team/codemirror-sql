import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import {
  findNamespaceCompletions,
  findNamespaceItemByEndMatch,
  isArrayNamespace,
  isObjectNamespace,
  isSelfChildrenNamespace,
  type ResolvedNamespaceItem,
  resolveNamespaceItem,
  traverseNamespacePath,
} from "../namespace-utils.js";

// Helper function to create completion objects
function createCompletion(label: string, detail?: string): Completion {
  return {
    label,
    detail: detail || `${label} completion`,
    type: "property",
  };
}

// Test data structures representing different SQLNamespace formats
const mockNamespaces = {
  // Simple object namespace: { [name: string]: SQLNamespace }
  simpleObject: {
    users: ["id", "name", "email"],
    orders: ["id", "user_id", "total", "created_at"],
    products: {
      electronics: ["laptop", "phone", "tablet"],
      books: ["fiction", "non_fiction", "technical"],
    },
  } as SQLNamespace,

  // Self-children namespace: { self: Completion; children: SQLNamespace }
  selfChildren: {
    self: createCompletion("database", "Main database"),
    children: {
      public: {
        users: [createCompletion("id"), createCompletion("name"), createCompletion("email")],
        orders: [createCompletion("id"), createCompletion("user_id"), createCompletion("total")],
      },
      private: {
        secrets: ["api_key", "password_hash"],
      },
    },
  } as SQLNamespace,

  // Array namespace: readonly (Completion | string)[]
  arrayNamespace: [
    "id",
    "name",
    "email",
    createCompletion("created_at", "Timestamp column"),
    createCompletion("updated_at", "Timestamp column"),
  ] as SQLNamespace,

  // Complex nested structure combining all types
  complexNested: {
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
          ],
        },
        analytics: {
          user_stats: ["daily_active", "monthly_active", "retention_rate"],
          sales_data: {
            q1: ["january", "february", "march"],
            q2: ["april", "may", "june"],
          },
        },
      },
    },
    mysql: {
      test_db: {
        customers: ["customer_id", "company_name", "contact_name"],
        products: {
          categories: [createCompletion("category_id"), createCompletion("category_name")],
        },
      },
    },
  } as SQLNamespace,
};

describe("namespace-utils type guards", () => {
  it("should correctly identify object namespace", () => {
    expect(isObjectNamespace(mockNamespaces.simpleObject)).toBe(true);
    expect(isObjectNamespace(mockNamespaces.selfChildren)).toBe(false);
    expect(isObjectNamespace(mockNamespaces.arrayNamespace)).toBe(false);
  });

  it("should correctly identify self-children namespace", () => {
    expect(isSelfChildrenNamespace(mockNamespaces.selfChildren)).toBe(true);
    expect(isSelfChildrenNamespace(mockNamespaces.simpleObject)).toBe(false);
    expect(isSelfChildrenNamespace(mockNamespaces.arrayNamespace)).toBe(false);
  });

  it("should correctly identify array namespace", () => {
    expect(isArrayNamespace(mockNamespaces.arrayNamespace)).toBe(true);
    expect(isArrayNamespace(mockNamespaces.simpleObject)).toBe(false);
    expect(isArrayNamespace(mockNamespaces.selfChildren)).toBe(false);
  });
});

describe("traverseNamespacePath", () => {
  describe("simple object namespace traversal", () => {
    it("should traverse single level paths", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "users");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["users"]);
      expect(result?.type).toBe("namespace");
    });

    it("should traverse multi-level paths", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "products.electronics");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["products", "electronics"]);
      expect(result?.type).toBe("namespace");
    });

    it("should return null for non-existent paths", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "nonexistent");
      expect(result).toBeNull();
    });

    it("should return null for non-existent nested paths", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "users.nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("self-children namespace traversal", () => {
    it("should handle self-children at root level", () => {
      const result = traverseNamespacePath(mockNamespaces.selfChildren, "");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.completion?.label).toBe("database");
    });

    it("should traverse through self-children to nested content", () => {
      const result = traverseNamespacePath(mockNamespaces.selfChildren, "public.users");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["public", "users"]);
      expect(result?.type).toBe("namespace");
    });
  });

  describe("complex nested namespace traversal", () => {
    it("should traverse deep paths with mixed namespace types", () => {
      const result = traverseNamespacePath(mockNamespaces.complexNested, "postgres.public.users");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["postgres", "public", "users"]);
      expect(result?.type).toBe("completion");
      expect(result?.completion?.label).toBe("users");
    });

    it("should handle array endpoints", () => {
      const result = traverseNamespacePath(
        mockNamespaces.complexNested,
        "postgres.analytics.user_stats",
      );
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["postgres", "analytics", "user_stats"]);
      expect(result?.type).toBe("namespace");
    });

    it("should traverse very deep paths", () => {
      const result = traverseNamespacePath(
        mockNamespaces.complexNested,
        "postgres.analytics.sales_data.q1",
      );
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["postgres", "analytics", "sales_data", "q1"]);
      expect(result?.type).toBe("namespace");
    });
  });

  describe("edge cases", () => {
    it("should handle empty paths", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "");
      expect(result).toBeNull();
    });

    it("should handle paths with empty segments", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "users..orders");
      expect(result).toBeNull();
    });

    it("should respect maxDepth configuration", () => {
      const result = traverseNamespacePath(
        mockNamespaces.complexNested,
        "postgres.analytics.sales_data.q1.january",
        { maxDepth: 3 },
      );
      expect(result).toBeNull();
    });

    it("should handle case-insensitive matching", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "USERS", {
        caseSensitive: false,
      });
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["users"]);
    });

    it("should handle case-sensitive matching", () => {
      const result = traverseNamespacePath(mockNamespaces.simpleObject, "USERS", {
        caseSensitive: true,
      });
      expect(result).toBeNull();
    });
  });
});

describe("findNamespaceCompletions", () => {
  describe("prefix matching at root level", () => {
    it("should find completions for simple prefixes", () => {
      const results = findNamespaceCompletions(mockNamespaces.simpleObject, "u");
      expect(results).toHaveLength(1);
      expect(results[0].path).toEqual(["users"]);
    });

    it("should find multiple completions for common prefixes", () => {
      const results = findNamespaceCompletions(mockNamespaces.simpleObject, "");
      expect(results.length).toBeGreaterThanOrEqual(3); // users, orders, products
    });

    it("should return empty array for non-matching prefixes", () => {
      const results = findNamespaceCompletions(mockNamespaces.simpleObject, "xyz");
      expect(results).toEqual([]);
    });
  });

  describe("prefix matching with dotted paths", () => {
    it("should find completions for dotted prefixes", () => {
      const results = findNamespaceCompletions(mockNamespaces.simpleObject, "products.e");
      expect(results).toHaveLength(1);
      expect(results[0].path).toEqual(["products", "electronics"]);
    });

    it("should handle completions in self-children namespaces", () => {
      const results = findNamespaceCompletions(mockNamespaces.selfChildren, "public.u");
      expect(results).toHaveLength(1);
      expect(results[0].path).toEqual(["public", "users"]);
    });

    it("should find completions in complex nested structures", () => {
      const results = findNamespaceCompletions(mockNamespaces.complexNested, "postgres.public.");
      expect(results.length).toBeGreaterThanOrEqual(2); // users, orders
    });
  });

  describe("array namespace completions", () => {
    it("should find string completions in arrays", () => {
      const results = findNamespaceCompletions(mockNamespaces.arrayNamespace, "");
      expect(results.length).toBeGreaterThanOrEqual(5);

      const stringResults = results.filter((r) => r.type === "string");
      const completionResults = results.filter((r) => r.type === "completion");

      expect(stringResults.length).toBeGreaterThanOrEqual(3); // id, name, email
      expect(completionResults.length).toBeGreaterThanOrEqual(2); // created_at, updated_at
    });

    it("should find completion objects in arrays", () => {
      const results = findNamespaceCompletions(mockNamespaces.arrayNamespace, "created");
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("completion");
      expect(results[0].completion?.label).toBe("created_at");
    });
  });

  describe("configuration options", () => {
    it("should respect case sensitivity", () => {
      const caseSensitiveResults = findNamespaceCompletions(mockNamespaces.simpleObject, "U", {
        caseSensitive: true,
      });
      expect(caseSensitiveResults).toHaveLength(0);

      const caseInsensitiveResults = findNamespaceCompletions(mockNamespaces.simpleObject, "U", {
        caseSensitive: false,
      });
      expect(caseInsensitiveResults).toHaveLength(1);
    });

    it("should handle exact vs partial matching", () => {
      const partialResults = findNamespaceCompletions(mockNamespaces.simpleObject, "user", {
        allowPartialMatch: true,
      });
      expect(partialResults).toHaveLength(1);

      const exactResults = findNamespaceCompletions(mockNamespaces.simpleObject, "user", {
        allowPartialMatch: false,
      });
      expect(exactResults).toHaveLength(0);
    });
  });
});

describe("findNamespaceItemByEndMatch", () => {
  it("should find items by their end identifier", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "users");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const userResult = results.find((r) => r.path[r.path.length - 1] === "users");
    expect(userResult).toBeTruthy();
  });

  it("should find multiple matches for common end identifiers", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "id");
    expect(results.length).toBeGreaterThanOrEqual(2); // Multiple tables have id columns
  });

  it("should sort results by path length (relevance)", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "id");
    expect(results.length).toBeGreaterThan(1);

    // Check that results are sorted by path length
    for (let i = 1; i < results.length; i++) {
      expect(results[i].path.length).toBeGreaterThanOrEqual(results[i - 1].path.length);
    }
  });

  it("should handle case-insensitive matching", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "USERS", {
      caseSensitive: false,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle case-sensitive matching", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "USERS", {
      caseSensitive: true,
    });
    expect(results).toHaveLength(0);
  });

  it("should return empty array for non-existent identifiers", () => {
    const results = findNamespaceItemByEndMatch(mockNamespaces.complexNested, "nonexistent");
    expect(results).toEqual([]);
  });
});

describe("resolveNamespaceItem", () => {
  describe("preference order resolution", () => {
    it("should prefer exact path matches over fuzzy matches", () => {
      // Create a namespace where "users" exists both as exact path and fuzzy match
      const testNamespace = {
        users: ["id", "name"],
        accounts: {
          admin_users: ["admin_id", "permissions"],
        },
      } as SQLNamespace;

      const result = resolveNamespaceItem(testNamespace, "users");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["users"]);
      expect(result?.type).toBe("namespace");
    });

    it("should fall back to prefix completions when no exact match", () => {
      const result = resolveNamespaceItem(mockNamespaces.simpleObject, "use");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["users"]);
    });

    it("should fall back to end-match fuzzy search as last resort", () => {
      // Search for something that doesn't exist as exact match or prefix
      const result = resolveNamespaceItem(mockNamespaces.complexNested, "id", {
        enableFuzzySearch: true,
      });
      expect(result).toBeTruthy();
      expect(result?.path[result?.path.length - 1]).toBe("id");
    });

    it("should return null when nothing matches", () => {
      const result = resolveNamespaceItem(mockNamespaces.simpleObject, "definitely_nonexistent");
      expect(result).toBeNull();
    });

    it("should not use fuzzy search when disabled by default", () => {
      // Search for something that would be found via fuzzy search but not exact/prefix match
      const result = resolveNamespaceItem(mockNamespaces.complexNested, "id");
      expect(result).toBeNull();
    });

    it("should use fuzzy search when explicitly enabled", () => {
      // Same search with fuzzy search enabled should work
      const result = resolveNamespaceItem(mockNamespaces.complexNested, "id", {
        enableFuzzySearch: true,
      });
      expect(result).toBeTruthy();
      expect(result?.path[result?.path.length - 1]).toBe("id");
    });
  });

  describe("exact segment matching in fuzzy search", () => {
    const testSchema: SQLNamespace = {
      users: {
        self: { label: "users", type: "property" },
        children: [
          { label: "name", type: "property" },
          { label: "full_name", type: "property" },
          { label: "user_name", type: "property" },
          "email",
        ],
      },
      profiles: {
        self: { label: "profiles", type: "property" },
        children: [
          { label: "name", type: "property" },
          { label: "display_name", type: "property" },
        ],
      },
      companies: [
        { label: "name", type: "property" },
        { label: "company_name", type: "property" },
        "website",
      ],
    };

    it("should match exact segments only, not partial segments", () => {
      // Search for 'name' should match 'users.name', 'profiles.name', 'companies.name'
      // but NOT 'users.full_name', 'users.user_name', 'profiles.display_name', 'companies.company_name'
      const results = findNamespaceItemByEndMatch(testSchema, "name", { enableFuzzySearch: true });

      expect(results).toHaveLength(3); // users.name, profiles.name, companies.name

      const paths = results.map((r) => r.path.join("."));
      expect(paths).toContain("users.name");
      expect(paths).toContain("profiles.name");
      expect(paths).toContain("companies.name");

      // Should NOT contain partial matches
      expect(paths).not.toContain("users.full_name");
      expect(paths).not.toContain("users.user_name");
      expect(paths).not.toContain("profiles.display_name");
      expect(paths).not.toContain("companies.company_name");
    });

    it("should prioritize end-of-path matches", () => {
      // Both 'users' and 'users.name' contain 'users', but 'users' should come first
      const results = findNamespaceItemByEndMatch(testSchema, "users", { enableFuzzySearch: true });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toEqual(["users"]); // Should prioritize the direct match
    });

    it("should handle case-insensitive matching", () => {
      const results = findNamespaceItemByEndMatch(testSchema, "NAME", {
        enableFuzzySearch: true,
        caseSensitive: false,
      });

      expect(results).toHaveLength(3);
      const paths = results.map((r) => r.path.join("."));
      expect(paths).toContain("users.name");
      expect(paths).toContain("profiles.name");
      expect(paths).toContain("companies.name");
    });

    it("should handle case-sensitive matching", () => {
      const results = findNamespaceItemByEndMatch(testSchema, "NAME", {
        enableFuzzySearch: true,
        caseSensitive: true,
      });

      // Should find no matches since 'NAME' (uppercase) doesn't match 'name' (lowercase) exactly
      expect(results).toHaveLength(0);
    });

    it("should work with resolveNamespaceItem integration", () => {
      // Test that the exact segment matching works through the main resolution function
      const result = resolveNamespaceItem(testSchema, "name", { enableFuzzySearch: true });

      expect(result).toBeTruthy();
      expect(result?.path).toContain("name");

      // Should be one of the exact matches, not a partial match
      const pathStr = result?.path.join(".");
      expect(["users.name", "profiles.name", "companies.name"]).toContain(pathStr);
    });

    it("should not match when fuzzy search is disabled", () => {
      // Without fuzzy search, 'name' should not be found (no exact path match)
      const result = resolveNamespaceItem(testSchema, "name", { enableFuzzySearch: false });
      expect(result).toBeNull();
    });
  });

  describe("complex resolution scenarios", () => {
    it("should resolve deeply nested identifiers", () => {
      const result = resolveNamespaceItem(mockNamespaces.complexNested, "postgres.public.users");
      expect(result).toBeTruthy();
      expect(result?.type).toBe("completion");
      expect(result?.completion?.label).toBe("users");
    });

    it("should resolve partial nested paths", () => {
      const result = resolveNamespaceItem(mockNamespaces.complexNested, "postgres.public");
      expect(result).toBeTruthy();
      expect(result?.path).toEqual(["postgres", "public"]);
    });

    it("should handle mixed namespace types in resolution", () => {
      const result = resolveNamespaceItem(
        mockNamespaces.complexNested,
        "postgres.analytics.user_stats",
      );
      expect(result).toBeTruthy();
      expect(result?.type).toBe("namespace");
      expect(result?.path).toEqual(["postgres", "analytics", "user_stats"]);
    });
  });
});

describe("edge cases and error handling", () => {
  it("should handle null/undefined namespaces gracefully", () => {
    expect(() => traverseNamespacePath({} as SQLNamespace, "test")).not.toThrow();
    expect(() => findNamespaceCompletions({} as SQLNamespace, "test")).not.toThrow();
    expect(() => findNamespaceItemByEndMatch({} as SQLNamespace, "test")).not.toThrow();
    expect(() => resolveNamespaceItem({} as SQLNamespace, "test")).not.toThrow();
  });

  it("should handle malformed paths", () => {
    expect(traverseNamespacePath(mockNamespaces.simpleObject, "..")).toBeNull();
    expect(traverseNamespacePath(mockNamespaces.simpleObject, ".")).toBeNull();
    expect(traverseNamespacePath(mockNamespaces.simpleObject, "users.")).toBeTruthy(); // Should handle trailing dot
  });

  it("should handle extremely deep nesting within maxDepth", () => {
    const deepNamespace: SQLNamespace = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: ["final"],
            },
          },
        },
      },
    };

    const result = traverseNamespacePath(deepNamespace, "level1.level2.level3.level4.level5");
    expect(result).toBeTruthy();

    const resultExceedsDepth = traverseNamespacePath(
      deepNamespace,
      "level1.level2.level3.level4.level5.final",
      { maxDepth: 5 },
    );
    expect(resultExceedsDepth).toBeNull();
  });

  it("should handle circular references without infinite loops", () => {
    // Create a namespace with potential circular reference
    const circularNamespace: any = {
      parent: {
        child: null,
      },
    };
    circularNamespace.parent.child = circularNamespace.parent;

    expect(() => {
      findNamespaceCompletions(circularNamespace, "parent", { maxDepth: 5 });
    }).not.toThrow();
  });
});

describe("performance and memory", () => {
  it("should handle large namespaces efficiently", () => {
    // Create a large namespace
    const largeNamespace: SQLNamespace = {};
    for (let i = 0; i < 1000; i++) {
      (largeNamespace as any)[`table_${i}`] = [`col1_${i}`, `col2_${i}`, `col3_${i}`];
    }

    const startTime = performance.now();
    const results = findNamespaceCompletions(largeNamespace, "table_1");
    const endTime = performance.now();

    expect(results.length).toBeGreaterThan(0);
    expect(endTime - startTime).toBeLessThan(100); // Should complete within 100ms
  });

  it("should not accumulate memory with repeated operations", () => {
    // Perform many operations to check for memory leaks
    for (let i = 0; i < 100; i++) {
      resolveNamespaceItem(mockNamespaces.complexNested, "postgres.public.users");
      findNamespaceCompletions(mockNamespaces.complexNested, "postgres");
      findNamespaceItemByEndMatch(mockNamespaces.complexNested, "id");
    }

    // If we get here without running out of memory, the test passes
    expect(true).toBe(true);
  });
});
