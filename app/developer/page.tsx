import { LocalAccessPanel } from "@/components/LocalAccessPanel";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { developerFromCookies } from "@/src/lib/access/localCredentials";
export default async function DeveloperPage() {
  if (developerFromCookies((await cookies()).toString())) redirect("/developer/scripts");
  return <LocalAccessPanel nextPath="/developer/scripts" />;
}
