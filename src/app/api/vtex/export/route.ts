import { NextResponse } from "next/server";
import {
  checkRateLimit,
  extractClientIp,
  normalizeValue,
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
};

type ExportResponse = {
  records: Record<string, unknown>[];
  batches: number;
  truncated: boolean;
};

const MAX_BATCHES = 200;
const PAGE_SIZE_V1 = 100;
const PAGE_SIZE_V2 = 100;

const buildHeaders = (
  appKey: string,
  appToken: string,
  token?: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-VTEX-API-AppKey": appKey,
    "X-VTEX-API-AppToken": appToken,
  };

  if (token) {
    headers["X-VTEX-MD-TOKEN"] = token;
  }

  return headers;
};

const buildBaseUrl = (accountName: string) =>
  `https://${accountName}.vtexcommercestable.com.br`;

const resolveV2Schema = async (
  baseUrl: string,
  entity: string,
  appKey: string,
  appToken: string,
  schema?: string,
) => {
  if (schema) {
    return schema;
  }

  const response = await fetch(`${baseUrl}/api/dataentities/${entity}/schemas`, {
    method: "GET",
    headers: buildHeaders(appKey, appToken),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const schemas = (await response.json()) as { name?: string }[];
  const first = schemas.find((item) => item.name)?.name;
  return first ?? null;
};

const exportV1Scroll = async (
  baseUrl: string,
  entity: string,
  appKey: string,
  appToken: string,
  schema?: string,
): Promise<ExportResponse | { error: string; status: number }> => {
  let token: string | undefined;
  let batches = 0;
  const visitedTokens = new Set<string>();
  const allRecords: Record<string, unknown>[] = [];

  while (batches < MAX_BATCHES) {
    batches += 1;

    const query = new URLSearchParams({
      _size: String(PAGE_SIZE_V1),
      _fields: "_all",
    });

    if (schema) {
      query.set("_schema", schema);
    }

    const response = await fetch(
      `${baseUrl}/api/dataentities/${entity}/scroll?${query.toString()}`,
      {
        method: "GET",
        headers: buildHeaders(appKey, appToken, token),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return {
        error: "Falha ao exportar registros do V1 via scroll.",
        status: response.status,
      };
    }

    const chunk = (await response.json()) as Record<string, unknown>[];
    allRecords.push(...chunk);

    const nextToken = response.headers.get("x-vtex-md-token") ?? undefined;

    if (!chunk.length || !nextToken || visitedTokens.has(nextToken)) {
      return {
        records: allRecords,
        batches,
        truncated: visitedTokens.has(nextToken ?? ""),
      };
    }

    visitedTokens.add(nextToken);
    token = nextToken;
  }

  return {
    records: allRecords,
    batches,
    truncated: true,
  };
};

const exportV2Search = async (
  baseUrl: string,
  entity: string,
  appKey: string,
  appToken: string,
  schema?: string,
): Promise<ExportResponse | { error: string; status: number }> => {
  const schemaToUse = await resolveV2Schema(
    baseUrl,
    entity,
    appKey,
    appToken,
    schema,
  );

  if (!schemaToUse) {
    return {
      error: "Nenhum schema disponível para esta entidade no V2.",
      status: 400,
    };
  }

  let page = 1;
  let batches = 0;
  const allRecords: Record<string, unknown>[] = [];

  while (batches < MAX_BATCHES) {
    batches += 1;

    const query = new URLSearchParams({
      _page: String(page),
      _size: String(PAGE_SIZE_V2),
      _fields: "_all",
      _schema: schemaToUse,
    });

    const response = await fetch(
      `${baseUrl}/api/dataentities/${entity}/search?${query.toString()}`,
      {
        method: "GET",
        headers: buildHeaders(appKey, appToken),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return {
        error: "Falha ao exportar registros do V2.",
        status: response.status,
      };
    }

    const chunk = (await response.json()) as Record<string, unknown>[];
    allRecords.push(...chunk);

    if (chunk.length < PAGE_SIZE_V2) {
      return {
        records: allRecords,
        batches,
        truncated: false,
      };
    }

    page += 1;
  }

  return {
    records: allRecords,
    batches,
    truncated: true,
  };
};

export async function POST(request: Request) {
  try {
    const requesterIp = extractClientIp(request);
    const rateLimit = checkRateLimit(`export:${requesterIp}`, 30, 60_000);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Muitas exportações em pouco tempo. Tente novamente." },
        { status: 429 },
      );
    }

    const body = (await request.json()) as RequestBody;

    const accountName = normalizeValue(body.accountName);
    const appKey = normalizeValue(body.appKey);
    const appToken = normalizeValue(body.appToken);
    const version = body.version ?? "v1";
    const entity = normalizeValue(body.entity);
    const schema = normalizeValue(body.schema);

    const credentialsError = validateCredentials(accountName, appKey, appToken);
    if (credentialsError) {
      return NextResponse.json({ error: credentialsError }, { status: 400 });
    }

    if (version !== "v1" && version !== "v2") {
      return NextResponse.json({ error: "Versão inválida." }, { status: 400 });
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

    const baseUrl = buildBaseUrl(accountName);

    const result =
      version === "v1"
        ? await exportV1Scroll(baseUrl, entity, appKey, appToken, schema || undefined)
        : await exportV2Search(baseUrl, entity, appKey, appToken, schema || undefined);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Erro ao exportar registros." },
      { status: 500 },
    );
  }
}
