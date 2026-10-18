import { expect, test } from "@playwright/test";

test("conversazione reale nel browser: errore, recupero, history e nuova conversazione", async ({
  page,
}) => {
  const requests = [];
  // Nessuna richiesta API può raggiungere il backend o un provider reale.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      if (
        new URL(request.url()).pathname !== "/api/chat" ||
        request.method() !== "POST"
      ) {
        throw new Error(
          `Richiesta API inattesa: ${request.method()} ${request.url()}`,
        );
      }
      requests.push(request.postDataJSON());
      if (requests.length === 1) {
        return route.fulfill({
          status: 503,
          json: { error: "Servizio temporaneamente occupato" },
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          answer: `**Risultato sintetico ${requests.length - 1}**: verifica operativa disponibile.`,
          artifacts: [],
        },
      });
    },
  );
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Messaggio" });
  await input.fill("Analizza SITE_03");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(
    "Servizio temporaneamente occupato",
  );
  await expect(input).toBeEnabled();
  await input.fill("Riprova SITE_03");
  await page.getByRole("button", { name: "Invia messaggio" }).click();
  await expect(
    page.getByText("Risultato sintetico 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests[1]).toEqual({ message: "Riprova SITE_03", history: [] });
  await page.reload();
  await expect(
    page.getByText("Risultato sintetico 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Analizza SITE_03", { exact: true })).toHaveCount(
    0,
  );
  await input.fill("Approfondisci");
  await input.press("Enter");
  await expect(
    page.getByText("Risultato sintetico 2", { exact: true }),
  ).toBeVisible();
  expect(requests[2]).toEqual({
    message: "Approfondisci",
    history: [
      { role: "user", content: "Riprova SITE_03" },
      {
        role: "assistant",
        content: "**Risultato sintetico 1**: verifica operativa disponibile.",
      },
    ],
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Nuova conversazione" }).click();
  await expect(
    page.getByText("Risultato sintetico 2", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("Risultato sintetico 1", { exact: true }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(3);
});
