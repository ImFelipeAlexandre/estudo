import { NextResponse } from "next/server";

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
    const body = (await request.json()) as RequestBody;
    const {
      accountName,
      appKey,
      appToken,
      version = "v1",
      entity,
      schema,
      page = 1,
      pageSize = 50,
    } = body;

    if (!accountName || !appKey || !appToken || !entity) {
      return NextResponse.json(
        { error: "Informe vendor, app key, app token e entidade." },
        { status: 400 },
      );
    }

    const baseUrl = buildBaseUrl(accountName);
    const headers = buildHeaders(appKey, appToken);
    const query = new URLSearchParams({
      _page: String(page),
      _size: String(pageSize),
      _fields: "_all",
    });

    if (version === "v2") {
      let schemaToUse = schema;

      if (!schemaToUse) {
        const schemasResponse = await fetch(
          `${baseUrl}/api/dataentities/${entity}/schemas`,
          {
            method: "GET",
            headers,
            cache: "no-store",
          },
        );

        if (!schemasResponse.ok) {
          return NextResponse.json(
            { error: "Não foi possível obter schemas do MasterData V2." },
            { status: schemasResponse.status },
          );
        }

        const schemas = (await schemasResponse.json()) as { name?: string }[];
        schemaToUse = schemas.find((item) => item.name)?.name;

        if (!schemaToUse) {
          return NextResponse.json(
            { error: "Nenhum schema disponível para esta entidade no V2." },
            { status: 400 },
          );
        }
      }

      query.set("_schema", schemaToUse);
    }

    const response = await fetch(
      `${baseUrl}/api/dataentities/${entity}/search?${query.toString()}`,
      {
        method: "GET",
        headers,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Falha ao carregar registros da entidade." },
        { status: response.status },
      );
    }

    const records = (await response.json()) as Record<string, unknown>[];
    const total = parseTotalFromHeaders(response.headers);
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

    return NextResponse.json({ records, pagination });
  } catch {
    return NextResponse.json(
      { error: "Erro ao consultar registros do MasterData." },
      { status: 500 },
    );
  }
}
