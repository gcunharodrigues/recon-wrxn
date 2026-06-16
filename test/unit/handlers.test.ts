/**
 * Unit Tests: MCP Tool Handlers (v6)
 *
 * Tests recon_find, recon_impact, recon_explain, recon_map, recon_rules
 * against a mock graph.
 *
 * The mock graph models a small Go + TS codebase:
 *
 *   [AuthMiddleware] --CALLS--> [ValidateToken] --CALLS--> [DecodeJWT]
 *   [LoginHandler]   --CALLS--> [ValidateToken]
 *   [UserService]    --CALLS--> [LoginHandler]
 *   [LoginPage]      --USES_COMPONENT--> [LoginForm]
 *   [LoginForm]      --CALLS_API--> [LoginHandler]
 *   [AuthPkg]        --IMPORTS--> [JWTPkg]
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { handleToolCall } from '../../src/mcp/handlers.js';

// ─── Mock Graph Builder ─────────────────────────────────────────

function makeNode(id: string, name: string, overrides?: Partial<Node>): Node {
  return {
    id,
    type: NodeType.Function,
    name,
    file: 'internal/auth/auth.go',
    startLine: 1,
    endLine: 10,
    language: Language.Go,
    package: 'internal/auth',
    exported: true,
    ...overrides,
  };
}

function makeRel(
  sourceId: string,
  targetId: string,
  type: RelationshipType = RelationshipType.CALLS,
  metadata?: Relationship['metadata'],
): Relationship {
  return {
    id: `${sourceId}-${type}-${targetId}`,
    type,
    sourceId,
    targetId,
    confidence: 1.0,
    metadata,
  };
}

function buildMockGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();

  // ── Packages ──
  g.addNode(makeNode('go:pkg:internal/auth', 'auth', {
    type: NodeType.Package,
    file: '',
    package: 'internal/auth',
    importPath: 'myapp/internal/auth',
    files: ['internal/auth/middleware.go', 'internal/auth/token.go'],
    imports: ['myapp/internal/jwt'],
  }));
  g.addNode(makeNode('go:pkg:internal/jwt', 'jwt', {
    type: NodeType.Package,
    file: '',
    package: 'internal/jwt',
    importPath: 'myapp/internal/jwt',
    files: ['internal/jwt/decode.go'],
    imports: [],
  }));

  // ── Go Functions ──
  g.addNode(makeNode('go:func:auth.AuthMiddleware', 'AuthMiddleware', {
    file: 'internal/auth/middleware.go',
    startLine: 10,
    endLine: 30,
    package: 'internal/auth',
  }));
  g.addNode(makeNode('go:func:auth.ValidateToken', 'ValidateToken', {
    file: 'internal/auth/token.go',
    startLine: 5,
    endLine: 25,
    package: 'internal/auth',
  }));
  g.addNode(makeNode('go:func:jwt.DecodeJWT', 'DecodeJWT', {
    file: 'internal/jwt/decode.go',
    startLine: 1,
    endLine: 20,
    package: 'internal/jwt',
  }));
  g.addNode(makeNode('go:func:handler.LoginHandler', 'LoginHandler', {
    file: 'apps/api/handler/login.go',
    startLine: 15,
    endLine: 45,
    package: 'apps/api/handler',
  }));
  g.addNode(makeNode('go:func:service.UserService', 'UserService', {
    file: 'apps/api/service/user.go',
    startLine: 10,
    endLine: 50,
    package: 'apps/api/service',
  }));

  // ── TS Components ──
  g.addNode(makeNode('ts:comp:LoginPage', 'LoginPage', {
    type: NodeType.Component,
    file: 'apps/web/src/pages/LoginPage.tsx',
    startLine: 5,
    endLine: 40,
    language: Language.TypeScript,
    package: 'apps/web/src/pages',
  }));
  g.addNode(makeNode('ts:comp:LoginForm', 'LoginForm', {
    type: NodeType.Component,
    file: 'apps/web/src/components/LoginForm.tsx',
    startLine: 1,
    endLine: 60,
    language: Language.TypeScript,
    package: 'apps/web/src/components',
  }));

  // ── Relationships ──
  // AuthMiddleware -> ValidateToken -> DecodeJWT
  g.addRelationship(makeRel(
    'go:func:auth.AuthMiddleware', 'go:func:auth.ValidateToken',
  ));
  g.addRelationship(makeRel(
    'go:func:auth.ValidateToken', 'go:func:jwt.DecodeJWT',
  ));
  // LoginHandler -> ValidateToken
  g.addRelationship(makeRel(
    'go:func:handler.LoginHandler', 'go:func:auth.ValidateToken',
  ));
  // UserService -> LoginHandler
  g.addRelationship(makeRel(
    'go:func:service.UserService', 'go:func:handler.LoginHandler',
  ));
  // LoginPage -> LoginForm (component usage)
  g.addRelationship(makeRel(
    'ts:comp:LoginPage', 'ts:comp:LoginForm',
    RelationshipType.USES_COMPONENT,
  ));
  // LoginForm -> LoginHandler (cross-language API call)
  g.addRelationship(makeRel(
    'ts:comp:LoginForm', 'go:func:handler.LoginHandler',
    RelationshipType.CALLS_API,
    { httpMethod: 'POST', urlPattern: '/api/auth/login' },
  ));
  // auth pkg -> jwt pkg
  g.addRelationship(makeRel(
    'go:pkg:internal/auth', 'go:pkg:internal/jwt',
    RelationshipType.IMPORTS,
  ));

  return g;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('recon_find handler', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = buildMockGraph();
  });

  it('finds symbols by substring match', async () => {
    const result = await handleToolCall('recon_find', { query: 'Login' }, graph);
    expect(result).toContain('LoginHandler');
    expect(result).toContain('LoginPage');
    expect(result).toContain('LoginForm');
  });

  it('returns result count', async () => {
    const result = await handleToolCall('recon_find', { query: 'Login' }, graph);
    expect(result).toContain('Found 3');
  });

  it('filters by type', async () => {
    const result = await handleToolCall('recon_find', {
      query: 'Login',
      type: 'Component',
    }, graph);
    expect(result).toContain('LoginPage');
    expect(result).toContain('LoginForm');
    expect(result).not.toContain('LoginHandler');
  });

  it('filters by language', async () => {
    const result = await handleToolCall('recon_find', {
      query: 'Login',
      language: 'go',
    }, graph);
    expect(result).toContain('LoginHandler');
    expect(result).not.toContain('LoginPage');
  });

  it('filters by package', async () => {
    const result = await handleToolCall('recon_find', {
      query: 'Login',
      package: 'apps/web',
    }, graph);
    expect(result).toContain('LoginPage');
    expect(result).toContain('LoginForm');
    expect(result).not.toContain('LoginHandler');
  });

  it('respects limit', async () => {
    const result = await handleToolCall('recon_find', {
      query: 'Login',
      limit: 1,
    }, graph);
    // Should only have 1 result entry (count the bold names)
    const entries = result.split('\n').filter(l => l.startsWith('- **'));
    expect(entries.length).toBe(1);
  });

  it('returns structured error on missing query', async () => {
    const result = await handleToolCall('recon_find', {}, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('invalid_parameter');
  });

  it('exact match appears in results', async () => {
    const result = await handleToolCall('recon_find', { query: 'DecodeJWT' }, graph);
    expect(result).toContain('DecodeJWT');
  });
});

describe('recon_impact handler', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = buildMockGraph();
  });

  it('finds upstream callers at d=1', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'ValidateToken',
      direction: 'upstream',
    }, graph);
    // d=1 should include AuthMiddleware and LoginHandler
    expect(result).toContain('AuthMiddleware');
    expect(result).toContain('LoginHandler');
    expect(result).toContain('WILL BREAK');
  });

  it('finds transitive upstream at d=2', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'ValidateToken',
      direction: 'upstream',
    }, graph);
    // d=2 should include UserService (calls LoginHandler which calls ValidateToken)
    expect(result).toContain('UserService');
  });

  it('finds downstream callees', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'AuthMiddleware',
      direction: 'downstream',
    }, graph);
    // d=1: ValidateToken
    expect(result).toContain('ValidateToken');
    // d=2: DecodeJWT
    expect(result).toContain('DecodeJWT');
  });

  it('reports risk level', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'ValidateToken',
      direction: 'upstream',
    }, graph);
    // 2 direct callers from different apps -> CRITICAL
    expect(result).toContain('CRITICAL');
  });

  it('respects maxDepth', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'ValidateToken',
      direction: 'upstream',
      maxDepth: 1,
    }, graph);
    // Only d=1, no UserService at d=2
    expect(result).toContain('AuthMiddleware');
    expect(result).not.toContain('UserService');
  });

  it('returns structured error on missing target', async () => {
    const result = await handleToolCall('recon_impact', { direction: 'upstream' }, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('invalid_parameter');
  });

  it('returns structured error on invalid direction', async () => {
    const result = await handleToolCall('recon_impact', { target: 'Foo', direction: 'sideways' }, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('invalid_parameter');
  });

  it('returns structured error on unknown symbol', async () => {
    const result = await handleToolCall('recon_impact', { target: 'NonExistent', direction: 'upstream' }, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('symbol_not_found');
  });

  it('disambiguates with file filter', async () => {
    const result = await handleToolCall('recon_impact', {
      target: 'ValidateToken',
      direction: 'upstream',
      file: 'token.go',
    }, graph);
    expect(result).toContain('ValidateToken');
  });
});

describe('recon_explain handler', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = buildMockGraph();
  });

  it('shows callers and callees', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'ValidateToken',
    }, graph);
    // Callers: AuthMiddleware, LoginHandler
    expect(result).toContain('AuthMiddleware');
    expect(result).toContain('LoginHandler');
    // Callees: DecodeJWT
    expect(result).toContain('DecodeJWT');
  });

  it('shows node metadata', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'ValidateToken',
    }, graph);
    expect(result).toContain('# Context: ValidateToken');
    expect(result).toContain('**Type:** Function');
    expect(result).toContain('**Language:** go');
    expect(result).toContain('internal/auth');
  });

  it('shows component usage relationships', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'LoginForm',
    }, graph);
    // Used by: LoginPage (USES_COMPONENT incoming)
    expect(result).toContain('LoginPage');
  });

  it('returns structured error on missing name', async () => {
    const result = await handleToolCall('recon_explain', {}, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('invalid_parameter');
  });

  it('returns structured error on unknown symbol', async () => {
    const result = await handleToolCall('recon_explain', { name: 'NonExistent' }, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('symbol_not_found');
  });

  it('disambiguates with file filter', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'ValidateToken',
      file: 'token.go',
    }, graph);
    expect(result).toContain('# Context: ValidateToken');
  });
});

describe('recon_map handler', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = buildMockGraph();
  });

  it('lists all packages', async () => {
    const result = await handleToolCall('recon_map', {}, graph);
    expect(result).toContain('internal/auth');
    expect(result).toContain('internal/jwt');
  });

  it('shows package overview header', async () => {
    const result = await handleToolCall('recon_map', {}, graph);
    expect(result).toContain('Package Overview');
  });

  it('shows node count', async () => {
    const result = await handleToolCall('recon_map', {}, graph);
    // Should contain stats line with node count
    expect(result).toContain('nodes');
  });
});

describe('recon_rules handler', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = buildMockGraph();
  });

  it('runs a specific rule', async () => {
    const result = await handleToolCall('recon_rules', { rule: 'dead_code' }, graph);
    expect(result).toContain('Rule: dead_code');
    expect(result).toContain('Issues found');
  });

  it('runs all rules when no rule specified', async () => {
    const result = await handleToolCall('recon_rules', {}, graph);
    expect(result).toContain('Code Quality Report');
    expect(result).toContain('dead_code');
    expect(result).toContain('unused_exports');
    expect(result).toContain('circular_deps');
    expect(result).toContain('large_files');
    expect(result).toContain('orphans');
  });

  it('returns structured error for invalid rule', async () => {
    const result = await handleToolCall('recon_rules', { rule: 'nonexistent' }, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('invalid_parameter');
  });
});

describe('unknown tool', () => {
  it('returns structured error for unknown tool name', async () => {
    const graph = buildMockGraph();
    const result = await handleToolCall('recon_nonexistent', {}, graph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('unknown_tool');
    expect(parsed.tool).toBe('recon_nonexistent');
  });
});

describe('empty graph', () => {
  it('returns empty_graph error for non-map tools', async () => {
    const emptyGraph = new KnowledgeGraph();
    const result = await handleToolCall('recon_find', { query: 'test' }, emptyGraph);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('empty_graph');
  });

  it('allows recon_map on empty graph', async () => {
    const emptyGraph = new KnowledgeGraph();
    const result = await handleToolCall('recon_map', {}, emptyGraph);
    // Should not return an error, but show empty overview
    expect(result).toContain('Package Overview');
  });
});

// ─── prose type-gate (recon-prose-analyzer-05) ──────────────────

describe('recon_impact prose type-gate', () => {
  it('excludes prose nodes from the blast radius of a code symbol', async () => {
    const g = new KnowledgeGraph();
    g.addNode(makeNode('go:func:Core', 'CoreFn', { file: 'internal/core/core.go' }));
    g.addNode(makeNode('go:func:Caller', 'CallerFn', { file: 'internal/core/caller.go' }));
    g.addNode(makeNode('md:page:doc', 'Core Architecture Guide', {
      type: NodeType.Page,
      file: 'docs/core.md',
      language: Language.Markdown,
      package: 'docs',
      exported: false,
    }));
    // code dependency: CallerFn calls CoreFn
    g.addRelationship(makeRel('go:func:Caller', 'go:func:Core', RelationshipType.CALLS));
    // prose link: the guide documents CoreFn (Page -> CodeSymbol)
    g.addRelationship(makeRel('md:page:doc', 'go:func:Core', RelationshipType.DOCUMENTED_BY));

    const result = await handleToolCall('recon_impact', {
      target: 'CoreFn',
      direction: 'upstream',
    }, g);

    // the code dependent IS in the blast radius
    expect(result).toContain('CallerFn');
    // the prose page must NOT leak into the blast radius
    expect(result).not.toContain('Core Architecture Guide');
  });

  it('does not pull documented code into the blast radius of a prose page (downstream)', async () => {
    // qa-finding-02: editing a doc does not "break" the code it documents.
    // DOCUMENTED_BY (Page -> code) is a documentation link, not a code dependency,
    // so a downstream impact on the Page must NOT traverse it into the code.
    const g = new KnowledgeGraph();
    g.addNode(makeNode('go:func:Core', 'CoreFn', { file: 'internal/core/core.go' }));
    g.addNode(makeNode('md:page:doc', 'Core Architecture Guide', {
      type: NodeType.Page,
      file: 'docs/core.md',
      language: Language.Markdown,
      package: 'docs',
      exported: false,
    }));
    g.addRelationship(makeRel('md:page:doc', 'go:func:Core', RelationshipType.DOCUMENTED_BY));

    const result = await handleToolCall('recon_impact', {
      target: 'Core Architecture Guide',
      direction: 'downstream',
    }, g);

    // the documented code must NOT be reported as impacted ("WILL BREAK")
    expect(result).not.toContain('WILL BREAK');
    expect(result).not.toContain('CoreFn');
  });
});

// ─── prose↔code documentation traversal (recon-prose-analyzer-06) ──

describe('recon_explain DOCUMENTED_BY traversal', () => {
  // A Page documents a Go symbol via a DOCUMENTED_BY edge (Page → code).
  // Page title is deliberately distinct from every code symbol name so
  // resolveSymbol's exported-preference does not steal the page (walk note).
  function graphWithDocEdge(): KnowledgeGraph {
    const g = buildMockGraph();
    g.addNode(makeNode('md:page:docs/auth.md', 'Auth Concept Guide', {
      type: NodeType.Page,
      file: 'docs/auth.md',
      language: Language.Markdown,
      package: 'docs',
      exported: false,
    }));
    // the guide documents ValidateToken (Page → CodeSymbol)
    g.addRelationship(makeRel(
      'md:page:docs/auth.md', 'go:func:auth.ValidateToken',
      RelationshipType.DOCUMENTED_BY,
    ));
    return g;
  }

  it('recon_explain on a PAGE lists the code symbols it documents', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'Auth Concept Guide',
    }, graphWithDocEdge());
    expect(result).toContain('# Context: Auth Concept Guide');
    expect(result).toContain('Documents');
    expect(result).toContain('ValidateToken');
  });

  it('recon_explain on a CODE symbol lists the documenting pages', async () => {
    const result = await handleToolCall('recon_explain', {
      name: 'ValidateToken',
    }, graphWithDocEdge());
    expect(result).toContain('Documented By');
    expect(result).toContain('Auth Concept Guide');
  });

  it('a code symbol with no documentation shows no Documented By section', async () => {
    // DecodeJWT is documented by nobody.
    const result = await handleToolCall('recon_explain', {
      name: 'DecodeJWT',
    }, graphWithDocEdge());
    expect(result).not.toContain('Documented By');
  });
});

describe('recon_map prose type-gate', () => {
  it('excludes prose from the language counts', async () => {
    const g = new KnowledgeGraph();
    g.addNode(makeNode('go:pkg:core', 'core', {
      type: NodeType.Package, file: '', package: 'core',
      importPath: 'core', files: [], imports: [],
    }));
    g.addNode(makeNode('go:func:Core', 'CoreFn', {
      file: 'core/core.go', language: Language.Go, package: 'core',
    }));
    g.addNode(makeNode('md:page:doc', 'Guide', {
      type: NodeType.Page, file: 'docs/g.md', language: Language.Markdown, package: 'docs', exported: false,
    }));
    g.addNode(makeNode('md:section:doc#h', 'Section H', {
      type: NodeType.Section, file: 'docs/g.md', language: Language.Markdown, package: 'docs', exported: false,
    }));

    // explicit nonexistent root → hermetic (no git/tech-stack side effects)
    const result = await handleToolCall('recon_map', {}, g, '/recon-prose-test-nonexistent');

    // the language breakdown is present and counts code
    expect(result).toContain('**Languages:**');
    expect(result).toContain('go: 1');
    // ...but prose (markdown) is excluded from it
    expect(result).not.toContain('markdown');
  });
});
