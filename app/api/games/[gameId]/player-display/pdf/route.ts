import { readScopedPlayerPdf } from "@/src/lib/access/playerPdf";
import { playerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { PlayerPdfReadingError } from "@/src/lib/services/playerPdfReadingService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

async function handleGET(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  const actIndexParam = request.nextUrl.searchParams.get("actIndex");

  try {
    const pdf = await readScopedPlayerPdf({
      gameSessionId: gameId,
      roleName: request.nextUrl.searchParams.get("roleName"),
      actIndex: actIndexParam ? Number(actIndexParam) : null,
      sectionId: request.nextUrl.searchParams.get("sectionId")
    });

    return new NextResponse(new Uint8Array(pdf.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${encodeURIComponent(pdf.fileName)}"`,
        "Cache-Control": "private, no-store",
        "X-Player-Display-Page-Range": `${pdf.pageStart}-${pdf.pageEnd}`
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof PlayerPdfReadingError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }

  return NextResponse.json({ error: "读取玩家 PDF 文件失败。" }, { status: 500 });
}

export const GET = playerRoute(handleGET);
