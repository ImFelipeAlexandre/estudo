import { NextResponse } from "next/server";

type VtexEntity = {
  acronym: string;
  name?: string;
  schema?: string;
};

type RequestBody = {
  accountName?: string;
  appKey?: string;
  appToken?: string;
  version?: "v1" | "v2";
};

const buildHeaders = (appKey: string, appToken: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": appKey,
  "X-VTEX-API-AppToken": appToken,
});

const buildBaseUrl = (accountName: string) =>
  `https://${accountName}.vtexcommercestable.com.br`;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const { accountName, appKey, appToken, version = "v1" } = body;

    if (!accountName || !appKey || !appToken) {
      return NextResponse.json(
        { error: "Informe vendor, app key e app token." },
        { status: 400 },
      );
    }

    const baseUrl = buildBaseUrl(accountName);
    const headers = buildHeaders(appKey, appToken);

    const entitiesResponse = await fetch(`${baseUrl}/api/dataentities`, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (!entitiesResponse.ok) {
      return NextResponse.json(
        { error: "Falha ao listar entidades no VTEX MasterData." },
        { status: entitiesResponse.status },
      );
    }

    const entities = (await entitiesResponse.json()) as VtexEntity[];

    if (version === "v1") {
      return NextResponse.json({ entities, version: "v1" });
    }

    const settled = await Promise.allSettled(
      entities.map(async (entity) => {
        const schemaResponse = await fetch(
          `${baseUrl}/api/dataentities/${entity.acronym}/schemas`,
          {
            method: "GET",
            headers,
            cache: "no-store",
          },
        );

        if (!schemaResponse.ok) {
          return [] as string[];
        }

        const schemas = (await schemaResponse.json()) as { name?: string }[];
        return schemas
          .map((item) => item.name)
          .filter((name): name is string => Boolean(name));
      }),
    );

    const v2Entities: VtexEntity[] = [];

    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        return;
      }

      const schemaNames = result.value;
      if (!schemaNames.length) {
        return;
      }

      schemaNames.forEach((schemaName) => {
        v2Entities.push({
          acronym: entities[index].acronym,
          name: entities[index].name,
          schema: schemaName,
        });
      });
    });

    return NextResponse.json({ entities: v2Entities, version: "v2" });
  } catch {
    return NextResponse.json(
      { error: "Erro ao consultar entidades do MasterData." },
      { status: 500 },
    );
  }
}
