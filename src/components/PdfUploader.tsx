import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileUp } from "lucide-react";

interface Props {
  onReady: (file: File, from: number, to: number, totalPages: number) => void;
}

export function PdfUploader({ onReady }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [drag, setDrag] = useState(false);

  const handleFile = useCallback(async (f: File) => {
    if (f.type !== "application/pdf") return;
    setFile(f);
    // probe total pages
    const { loadPdf } = await import("@/lib/pdf");
    const pdf = await loadPdf(f);
    setTotal(pdf.numPages);
    setFrom(1);
    setTo(Math.min(5, pdf.numPages));
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={`rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
          drag ? "border-primary bg-primary/5" : "border-border bg-card"
        }`}
      >
        <FileUp className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-4 font-medium">Drop a PDF here, or click to browse</p>
        <p className="text-sm text-muted-foreground">Scanned Physics / Maths textbook pages</p>
        <Input
          type="file"
          accept="application/pdf"
          className="mx-auto mt-4 max-w-xs"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>

      {file && total > 0 && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div>
            <p className="font-medium">{file.name}</p>
            <p className="text-sm text-muted-foreground">{total} pages total</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>From page</Label>
              <Input
                type="number"
                min={1}
                max={total}
                value={from}
                onChange={(e) => setFrom(Math.max(1, Math.min(total, +e.target.value || 1)))}
              />
            </div>
            <div>
              <Label>To page</Label>
              <Input
                type="number"
                min={from}
                max={total}
                value={to}
                onChange={(e) => setTo(Math.max(from, Math.min(total, +e.target.value || from)))}
              />
            </div>
          </div>
          <Button className="w-full" onClick={() => onReady(file, from, to, total)}>
            Process pages {from} – {to}
          </Button>
        </div>
      )}
    </div>
  );
}
