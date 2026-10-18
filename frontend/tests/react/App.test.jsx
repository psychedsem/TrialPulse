import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.jsx";

const image = {
  type: "image",
  mime_type: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJawAAAAASUVORK5CYII=",
  alt: "Arruolamento sintetico per studio",
};

function response(answer, artifacts = []) {
  return new Response(JSON.stringify({ answer, artifacts }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Conversazione React", () => {
  it("blocca invii vuoti e duplicati durante la richiesta e mostra la risposta Markdown", async () => {
    let resolveRequest;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Messaggio" });
    const send = screen.getByRole("button", { name: "Invia messaggio" });
    expect(send).toBeDisabled();
    await user.type(input, "   ");
    expect(send).toBeDisabled();
    await user.clear(input);
    await user.type(input, "  Analizza SITE_03  ");
    await user.click(send);
    expect(screen.getByRole("status")).toHaveTextContent("sta analizzando");
    expect(input).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Nuova conversazione" }),
    ).toBeDisabled();
    await user.click(send);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      message: "Analizza SITE_03",
      history: [],
    });
    const answer =
      "**SITE_03** richiede una verifica operativa.\n\n|Studio|Arruolati|\n|---|---|\n|PSI|36|";
    await act(async () => resolveRequest(response(answer)));
    expect(
      await screen.findByText("SITE_03", { selector: "strong" }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Arruolati" }),
    ).toBeVisible();
    expect(screen.getByRole("cell", { name: "36" })).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(
      JSON.parse(sessionStorage.getItem("trialpulse.conversation")).history,
    ).toEqual([
      { role: "user", content: "Analizza SITE_03" },
      {
        role: "assistant",
        content: answer,
      },
    ]);
  });

  it("mostra l'errore di rete e consente un nuovo invio", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(response("Connessione ripristinata.")),
    );
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Messaggio" });
    await user.type(input, "Analisi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /servizio non è disponibile/i,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Failed to fetch");
    expect(input).toBeEnabled();
    await user.type(input, "Riprova{Enter}");
    expect(await screen.findByText("Connessione ripristinata.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("recupera da un errore senza inserire il turno fallito nella history successiva", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Servizio temporaneamente occupato" }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(response("Analisi sintetica disponibile."));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Messaggio" });
    await user.type(input, "Primo tentativo{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Servizio temporaneamente occupato",
    );
    expect(sessionStorage.getItem("trialpulse.conversation")).toBeNull();
    await user.type(input, "Riprova analisi{Enter}");
    expect(
      await screen.findByText("Analisi sintetica disponibile."),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      message: "Riprova analisi",
      history: [],
    });
    expect(
      JSON.parse(sessionStorage.getItem("trialpulse.conversation")).history,
    ).toHaveLength(2);
  });

  it("ripristina testo e PNG dopo il remount e li cancella solo dopo conferma", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response("Risultato sintetico", [image])),
    );
    const user = userEvent.setup();
    const first = render(<App />);
    await user.type(
      screen.getByRole("textbox", { name: "Messaggio" }),
      "Grafico{Enter}",
    );
    expect(await screen.findByRole("img", { name: image.alt })).toHaveAttribute(
      "src",
      `data:image/png;base64,${image.data}`,
    );
    first.unmount();
    render(<App />);
    expect(screen.getByText("Risultato sintetico")).toBeVisible();
    expect(screen.getByRole("img", { name: image.alt })).toBeVisible();
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const reset = screen.getByRole("button", { name: "Nuova conversazione" });
    await user.click(reset);
    expect(screen.getByText("Risultato sintetico")).toBeVisible();
    await user.click(reset);
    expect(screen.queryByText("Risultato sintetico")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: image.alt }),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem("trialpulse.conversation")).toBeNull();
    expect(sessionStorage.getItem("trialpulse.artifacts")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Messaggio" })).toHaveFocus(),
    );
  });

  it("Shift+Enter conserva una nuova riga senza inviare il messaggio", async () => {
    const fetch = vi.fn().mockResolvedValue(response("Ricevuto"));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Messaggio" });
    await user.type(input, "Studio PSI{Shift>}{Enter}{/Shift}SITE_01");
    expect(input).toHaveValue("Studio PSI\nSITE_01");
    expect(fetch).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Ricevuto")).toBeVisible();
    expect(JSON.parse(fetch.mock.calls[0][1].body).message).toBe(
      "Studio PSI\nSITE_01",
    );
  });
});
