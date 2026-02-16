import { NextResponse } from "next/server";
import {
  checkRateLimit,
  extractClientIp,
  normalizeValue,
  sanitizePagination,
  validateCredentials,
  validateEntityIdentifier,
} from "@/lib/security";

type RequestBody = {
  accountName?: string;
  appKey?: string;
  appToken?: string;
  version?: "v1" | "v2";
  entity?: string;
  schema?: string;
  page?: number;
  pageSize?: number;
};

type Pagination = {
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
};

const buildHeaders = (appKey: string, appToken: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
});

const buildBaseUrl = (accountName: string) =>
  `https://${accountName}.vtexcommercestable.com.br`;

const fetchSchemas = async (
  baseUrl: string,
  entity: string,
  headers: Record<string, string>,
) => {
  const schemasResponse = await fetch(
    `${baseUrl}/api/dataentities/${entity}/schemas`,
    {
      method: "GET",
      headers,
      cache: "no-store",
    },
  );

  if (!schemasResponse.ok) {
    return [] as string[];
  }

  const schemas = (await schemasResponse.json()) as { name?: string }[];
  return schemas
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name));
};

const fetchRecordsBySchema = async (
  baseUrl: string,
  entity: string,
  headers: Record<string, string>,
  page: number,
  pageSize: number,
  schemaName?: string,
) => {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const query = new URLSearchParams({
    _fields: "_all",
    _sort: "id ASC",
  });

  if (schemaName) {
    query.set("_schema", schemaName);
  }

  const requestHeaders = {
    ...headers,
    "REST-Range": `resources=${from}-${to}`,
  };

  const response = await fetch(
    `${baseUrl}/api/dataentities/${entity}/search?${query.toString()}`,
    {
      method: "GET",
      headers: requestHeaders,
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      records: [] as Record<string, unknown>[],
      total: null as number | null,
      schemaUsed: schemaName,
    };
  }

  const records = (await response.json()) as Record<string, unknown>[];
  const total = parseTotalFromHeaders(response.headers);

  return {
    ok: true,
    status: response.status,
    records,
    total,
    schemaUsed: schemaName,
  };
};

const parseTotalFromHeaders = (headers: Headers): number | null => {
  const directTotal = headers.get("x-vtex-md-total");
  if (directTotal && Number.isFinite(Number(directTotal))) {
    return Number(directTotal);
  }

  const contentRange = headers.get("rest-content-range");
  if (!contentRange) {
    return null;
  }

  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    return null;
  }

  return Number(match[1]);
};

export async function POST(request: Request) {
  try {
    const requesterIp = extractClientIp(request);
    const rateLimit = checkRateLimit(`documents:${requesterIp}`, 120, 60_000);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Muitas requisições. Tente novamente em instantes." },
        { status: 429 },
      );
    }

    const body = (await request.json()) as RequestBody;
    const {
      accountName: rawAccountName,
      appKey: rawAppKey,
      appToken: rawAppToken,
      version = "v1",
      entity: rawEntity,
      schema: rawSchema,
      page: rawPage,
      pageSize: rawPageSize,
    } = body;

    if (version !== "v1" && version !== "v2") {
      return NextResponse.json({ error: "Versão inválida." }, { status: 400 });
    }

    const accountName = normalizeValue(rawAccountName);
    const appKey = normalizeValue(rawAppKey);
    const appToken = normalizeValue(rawAppToken);
    const entity = normalizeValue(rawEntity);
    const schema = normalizeValue(rawSchema);

    const credentialsError = validateCredentials(accountName, appKey, appToken);
    if (credentialsError) {
      return NextResponse.json({ error: credentialsError }, { status: 400 });
    }

    const entityError = validateEntityIdentifier(entity, "Entidade");
    if (entityError) {
      return NextResponse.json({ error: entityError }, { status: 400 });
    }

    if (schema) {
      const schemaError = validateEntityIdentifier(schema, "Schema");
      if (schemaError) {
        return NextResponse.json({ error: schemaError }, { status: 400 });
      }
    }

    const paginationInput = sanitizePagination(rawPage, rawPageSize);
    if ("error" in paginationInput) {
      return NextResponse.json({ error: paginationInput.error }, { status: 400 });
    }

    const { page, pageSize } = paginationInput;

    const baseUrl = buildBaseUrl(accountName);
    const headers = buildHeaders(appKey, appToken);
    let queryResult = await fetchRecordsBySchema(
      baseUrl,
      entity,
      headers,
      page,
      pageSize,
      undefined,
    );

    if (version === "v2") {
      let schemaToUse = schema || undefined;

      if (!schemaToUse) {
        const schemas = await fetchSchemas(baseUrl, entity, headers);
        schemaToUse = schemas[0];
      }

      if (!schemaToUse) {
        return NextResponse.json(
          { error: "Nenhum schema disponível para esta entidade no V2." },
          { status: 400 },
        );
      }

      queryResult = await fetchRecordsBySchema(
        baseUrl,
        entity,
        headers,
        page,
        pageSize,
        schemaToUse,
      );
    }

    if (version === "v1" && queryResult.ok && queryResult.records.length === 0) {
      const schemas = await fetchSchemas(baseUrl, entity, headers);

      for (const schemaName of schemas) {
        const fallbackResult = await fetchRecordsBySchema(
          baseUrl,
          entity,
          headers,
          page,
          pageSize,
          schemaName,
        );

        if (fallbackResult.ok && fallbackResult.records.length > 0) {
          queryResult = fallbackResult;
          break;
        }
      }
    }

    if (!queryResult.ok) {
      return NextResponse.json(
        { error: "Falha ao carregar registros da entidade." },
        { status: queryResult.status },
      );
    }

    const { records, total } = queryResult;
    const computedTotalPages =
      total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

    const pagination: Pagination = {
      page,
      pageSize,
      total,
      totalPages: computedTotalPages,
      hasPrevious: page > 1,
      hasNext:
        computedTotalPages !== null
          ? page < computedTotalPages
          : records.length === pageSize,
    };

    return NextResponse.json({ records, pagination, schemaUsed: queryResult.schemaUsed ?? null });
  } catch {
    return NextResponse.json(
      { error: "Erro ao consultar registros do MasterData." },
      { status: 500 },
    );
  }
}
