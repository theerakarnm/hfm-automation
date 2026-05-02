import { FileX2 } from "lucide-react"

export function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <FileX2 className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}
