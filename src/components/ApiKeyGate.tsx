import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { KeyRound, ExternalLink } from "lucide-react";

export function ApiKeyGate({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-center">Connect Gemini API</CardTitle>
          <CardDescription className="text-center">
            Your key is stored only in this browser's localStorage. Never sent to our servers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="password"
            placeholder="AIza..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && onSave(value.trim())}
          />
          <Button
            className="w-full"
            disabled={!value.trim()}
            onClick={() => onSave(value.trim())}
          >
            Save & Continue
          </Button>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Get an API key <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
