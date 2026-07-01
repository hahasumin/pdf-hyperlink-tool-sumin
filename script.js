pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const pdfInput = document.getElementById("pdfFile");
const csvInput = document.getElementById("csvFile");
const startBtn = document.getElementById("startBtn");
const logBox = document.getElementById("log");

function log(message) {
  logBox.textContent += message + "\n";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = [];
    let current = "";
    let insideQuotes = false;

    for (const char of line) {
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    values.push(current.trim());

    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });

    return row;
  });
}

async function getPdfTextItems(pdfBytes, pageNumber) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();

  return textContent.items.map(item => {
    const x = item.transform[4];
    const y = item.transform[5];

    return {
      text: item.str,
      normalized: normalizeText(item.str),
      x,
      y,
      width: item.width,
      height: Math.abs(item.transform[0]) || 10
    };
  });
}

function itemToRect(item) {
  return {
    x: item.x,
    y: item.y - 2,
    width: item.width,
    height: item.height + 4
  };
}

function combineRects(rects) {
  const x0 = Math.min(...rects.map(r => r.x));
  const y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.width));
  const y1 = Math.max(...rects.map(r => r.y + r.height));

  return {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0
  };
}

function findLineRect(textItems, targetText) {
  const target = normalizeText(targetText);

  // Exact match first
  for (const item of textItems) {
    if (item.normalized === target) {
      return itemToRect(item);
    }
  }

  // Partial match fallback
  for (const item of textItems) {
    if (item.normalized.includes(target)) {
      return itemToRect(item);
    }
  }

  return null;
}

function addLinkAnnotation(pdfDoc, page, rect, url) {
  page.node.addAnnot(
    pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [
        rect.x,
        rect.y,
        rect.x + rect.width,
        rect.y + rect.height
      ],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFLib.PDFString.of(url)
      }
    })
  );
}

function drawUnderline(page, rect) {
  page.drawLine({
    start: { x: rect.x, y: rect.y },
    end: { x: rect.x + rect.width, y: rect.y },
    thickness: 0.5
  });
}

startBtn.addEventListener("click", async () => {
  logBox.textContent = "";

  const pdfFile = pdfInput.files[0];
  const csvFile = csvInput.files[0];

  if (!pdfFile || !csvFile) {
    alert("Please select both PDF and CSV files.");
    return;
  }

  try {
    log("Reading files...");

    const pdfBytes = await pdfFile.arrayBuffer();
    const csvText = await csvFile.text();
    const rows = parseCSV(csvText);

    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes.slice(0));
    const pages = pdfDoc.getPages();

    let inserted = 0;
    const failed = [];

    log(`PDF pages: ${pages.length}`);
    log(`CSV rows: ${rows.length}`);
    log("");

    for (const row of rows) {
      const matchText = normalizeText(row.match_text);
      const url = normalizeText(row.url);

      if (!matchText || !url) {
        failed.push({
          match_text: matchText,
          url,
          reason: "Missing match_text or url"
        });
        continue;
      }

      const lines = matchText
        .split("|")
        .map(t => normalizeText(t))
        .filter(Boolean);

      let foundAny = false;

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const pageNumber = pageIndex + 1;
        const page = pages[pageIndex];

        const textItems = await getPdfTextItems(pdfBytes, pageNumber);

        const rects = [];

        for (const line of lines) {
          const rect = findLineRect(textItems, line);
          if (rect) {
            rects.push(rect);
          }
        }

        if (rects.length === lines.length) {
          const linkRect = combineRects(rects);

          addLinkAnnotation(pdfDoc, page, linkRect, url);

          for (const rect of rects) {
            drawUnderline(page, rect);
          }

          inserted++;
          foundAny = true;

          log(`Inserted: Page ${pageNumber} - ${matchText}`);
        }
      }

      if (!foundAny) {
        failed.push({
          match_text: matchText,
          url,
          reason: "Text not found in PDF"
        });
      }
    }

    const modifiedPdfBytes = await pdfDoc.save();

    const blob = new Blob([modifiedPdfBytes], {
      type: "application/pdf"
    });

    const downloadUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = pdfFile.name.replace(/\.pdf$/i, "_with_links.pdf");
    a.click();

    log("");
    log("Done.");
    log(`Inserted links: ${inserted}`);
    log(`Failed: ${failed.length}`);

    if (failed.length > 0) {
      log("");
      log("Failed items:");
      failed.forEach(item => {
        log(`${item.match_text} - ${item.reason}`);
      });

      downloadFailedReport(failed);
    }

  } catch (error) {
    console.error(error);
    alert("Error: " + error.message);
  }
});

function downloadFailedReport(failed) {
  const header = "match_text,url,reason\n";
  const rows = failed.map(item => {
    return [
      `"${String(item.match_text || "").replace(/"/g, '""')}"`,
      `"${String(item.url || "").replace(/"/g, '""')}"`,
      `"${String(item.reason || "").replace(/"/g, '""')}"`
    ].join(",");
  });

  const csvContent = header + rows.join("\n");

  const blob = new Blob([csvContent], {
    type: "text/csv"
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "failed_report.csv";
  a.click();
}
