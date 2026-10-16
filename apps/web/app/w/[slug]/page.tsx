import { redirect } from "next/navigation";

export default async function WorkspaceHome({ params }: { params: Promise<{ slug: string }> }) {
  redirect(`/w/${(await params).slug}/scenarios`);
}
