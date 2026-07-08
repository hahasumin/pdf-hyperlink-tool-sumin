pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const pdfInput = document.getElementById("pdfFile");
const csvInput = document.getElementById("csvFile");
const startBtn = document.getElementById("startBtn");
const logBox = document.getElementById("log");

function log(message) {
  logBox.textContent += message + "\n";
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = [];
    let current = "";
    let insideQuotes = false;

    for (const char of line) {
      if (char === '"') insideQuotes = !insideQuotes;
      else if (char === "," && !insideQuotes) {
        values.push(current.trim());
        current = "";
      } else current += char;
    }

    values.push(current.trim());

    const row = {};
    headers.forEach((h, i) => row[h] = values[i] || "");
    return row;
  });
}

async function getTextLines(pdfBytes, pageNumber) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice(0) });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const items = textContent.items
    .filter(item => normalize(item.str))
    .map(item => ({
      text: normalize(item.str),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: Math.abs(item.transform[0]) || 10
    }));

  items.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });

  return items;
}

function groupLinkedLines(lines, startIndex) {
  const first = lines[startIndex];
  const group = [first];

  const X_TOLERANCE = 12;
  const MIN_Y_GAP = 7;
  const MAX_Y_GAP = 16;
  const MAX_LINES = 3;

  let baseLine = first;

  while (group.length < MAX_LINES) {
    let bestCandidate = null;
    let bestGap = Infinity;

    for (const line of lines) {
      if (group.includes(line)) continue;

      const yGap = baseLine.y - line.y;
      const xGap = Math.abs(line.x - first.x);

      const isDirectlyBelow =
        yGap >= MIN_Y_GAP &&
        yGap <= MAX_Y_GAP;

      const hasSameLeftEdge =
        xGap <= X_TOLERANCE;

      const startsNewBuilding =
        /^Building\s+\d+/i.test(line.text);

      if (
        isDirectlyBelow &&
        hasSameLeftEdge &&
        !startsNewBuilding &&
        yGap < bestGap
      ) {
        bestCandidate = line;
        bestGap = yGap;
      }
    }

    if (!bestCandidate) break;

    group.push(bestCandidate);
    baseLine = bestCandidate;
  }

  return group;
}

function rectFromLine(line) {
  return {
    x: line.x,
    y: line.y - 2,
    width: line.width,
    height: line.height + 4
  };
}

function combineRects(rects) {
  const x0 = Math.min(...rects.map(r => r.x));
  const y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.width));
  const y1 = Math.max(...rects.map(r => r.y + r.height));

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function addLink(pdfDoc, page, rect, url) {
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

function underline(page, rect) {
  page.drawLine({
    start: { x: rect.x, y: rect.y },
    end: { x: rect.x + rect.width, y: rect.y },
    thickness: 0.5
  });
}

function downloadFailedReport(failed) {
  if (!failed.length) return;

  const header = "contains,url,reason\n";
  const rows = failed.map(item =>
    [
      `"${String(item.contains).replace(/"/g, '""')}"`,
      `"${String(item.url).replace(/"/g, '""')}"`,
      `"${String(item.reason).replace(/"/g, '""')}"`
    ].join(",")
  );

  const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "failed_report.csv";
  a.click();
}

startBtn.addEventListener("click", async () => {
  logBox.textContent = "";

  const pdfFile = pdfInput.files[0];
  const csvFile = csvInput.files[0];

  if (!pdfFile || !csvFile) {
    alert("Please select both PDF and CSV files.");
    return;
  }

  const pdfBytes = await pdfFile.arrayBuffer();
  const csvText = await csvFile.text();
  const rules = parseCSV(csvText);

  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes.slice(0));
  const pages = pdfDoc.getPages();

  let inserted = 0;
  const failed = [];
  const matchedSummary = {};

  log(`PDF pages: ${pages.length}`);
  log(`Rules: ${rules.length}`);
  log("");

  for (const rule of rules) {
    const contains = normalize(rule.contains);
    const url = normalize(rule.url);

    if (!contains || !url) {
      failed.push({ contains, url, reason: "Missing contains or url" });
      continue;
    }

    let found = false;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const pageNumber = pageIndex + 1;
      const page = pages[pageIndex];
      const lines = await getTextLines(pdfBytes, pageNumber);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

       const escaped = contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let regex;

if (/^Building\s+\d+/i.test(contains)) {
    // Building 번호인 경우
    regex = new RegExp(`${escaped}(?!\\d)`, "i");
} else {
    // 일반 텍스트인 경우
    regex = new RegExp(`\\b${escaped}\\b`, "i");
}

if (!regex.test(line.text)) continue;

if (!regex.test(line.text)) continue;

        const group = groupLinkedLines(lines, i);
        const rects = group.map(rectFromLine);
        const linkRect = combineRects(rects);

        addLink(pdfDoc, page, linkRect, url);

        rects.forEach(rect => underline(page, rect));

        inserted++;
found = true;

if (!matchedSummary[contains]) {
  matchedSummary[contains] = {
    count: 0,
    pages: []
  };
}

matchedSummary[contains].count++;
matchedSummary[contains].pages.push(pageNumber);

log(`Inserted: Page ${pageNumber} - ${group.map(g => g.text).join(" | ")}`);
      }
    }

    if (!found) {
      failed.push({
        contains,
        url,
        reason: "No matching text found"
      });
    }
  }

  const modifiedPdfBytes = await pdfDoc.save();
  const blob = new Blob([modifiedPdfBytes], { type: "application/pdf" });
  const downloadUrl = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = pdfFile.name.replace(/\.pdf$/i, "_with_links.pdf");
  a.click();

  downloadFailedReport(failed);

  log("");
log("================================");
log("Done.");
log(`Inserted links : ${inserted}`);
log(`Failed         : ${failed.length}`);

log("");
log("Matched summary:");
log("--------------------------------");

Object.keys(matchedSummary).forEach(key => {
  const item = matchedSummary[key];
  const uniquePages = [...new Set(item.pages)];

  log(`• ${key}`);
  log(`  Matched : ${item.count}`);
  log(`  Pages   : ${uniquePages.join(", ")}`);
  log("");
});

if (failed.length > 0) {
  log("Failed items:");
  log("--------------------------------");

  failed.forEach(item => {
    log(`• ${item.contains || "(blank)"}`);
    log(`  URL    : ${item.url || "(blank)"}`);
    log(`  Reason : ${item.reason}`);
    log("");
  });
}
});
