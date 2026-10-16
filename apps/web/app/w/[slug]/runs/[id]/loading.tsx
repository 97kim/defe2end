// s-3: the result page's shape while the run loads.
const bar = (w: string, h = "h-3") => <span className={`block ${h} ${w} rounded-full bg-border/70`} />;

export default function Loading() {
  return (
    <div aria-busy="true" className="motion-safe:animate-pulse">
      <header className="flex min-h-[88px] flex-col justify-center gap-2 border-b border-border bg-bg-surface px-8">
        {bar("w-32")}
        {bar("w-40", "h-6")}
      </header>
      <div className="flex flex-col gap-6 p-8">
        <div className="rounded-card border border-border bg-bg-surface p-6 shadow-e1">
          <div className="flex items-center gap-4">
            <span className="size-12 rounded-item bg-border/70" />
            <div className="flex flex-1 flex-col gap-2">
              {bar("w-1/3", "h-5")}
              {bar("w-1/2")}
            </div>
            <span className="h-9 w-28 rounded-control bg-border/70" />
            <span className="h-9 w-36 rounded-control bg-border/70" />
          </div>
          <div className="mt-5 grid grid-cols-6 gap-4 border-t border-border pt-5">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                {bar("w-16")}
                {bar("w-24")}
              </div>
            ))}
          </div>
        </div>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="rounded-card border border-border bg-bg-surface shadow-e1">
            <div className="border-b border-border px-6 py-4">{bar("w-20")}</div>
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-border px-6 py-4 last:border-b-0">
                <span className="size-4 rounded-full bg-border/70" />
                {bar("w-6")}
                {bar("w-20")}
                {bar(i % 2 ? "w-64" : "w-48")}
                <span className="ml-auto">{bar("w-10")}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-6">
            <div className="h-64 rounded-card border border-border bg-bg-surface shadow-e1" />
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} className="aspect-[4/3] rounded-control bg-border/70" />
              ))}
            </div>
            <div className="h-36 rounded-card border border-border bg-bg-surface shadow-e1" />
          </div>
        </div>
      </div>
    </div>
  );
}
