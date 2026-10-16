import { PlaceholderPage } from "../../../../components/placeholder-page";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <PlaceholderPage slug={(await params).slug} nav="comparisons" />;
}
