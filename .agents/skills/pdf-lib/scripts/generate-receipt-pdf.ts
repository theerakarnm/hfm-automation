import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

interface ReceiptLineItem {
  description: string;
  rightEyePrescription: string | null;
  leftEyePrescription: string | null;
  quantity: number;
  lineTotal: number;
}

interface ReceiptData {
  billingCompanyName: string;
  billingHeaderCode: string;
  documentNumber: string;
  documentType: 'receipt' | 'tax_invoice';
  issuedAt: string;
  taxpayerName: string;
  taxpayerAddress: string;
  taxpayerTaxId: string | null;
  items: ReceiptLineItem[];
  subtotal: number;
  discountType: 'amount' | 'percent';
  discountValue: number;
  discountAmount: number;
  vatEnabled: boolean;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
}

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT_MARGIN = 45;
const RIGHT_MARGIN = 45;
const TOP_MARGIN = 50;
const BOTTOM_MARGIN = 60;
const CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN;

export async function generateReceiptPdf(
  data: ReceiptData,
  fontBytes: Uint8Array,
  boldFontBytes: Uint8Array,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const regular = await pdfDoc.embedFont(fontBytes, { subset: true });
  const bold = await pdfDoc.embedFont(boldFontBytes, { subset: true });
  const fonts: FontSet = { regular, bold };

  pdfDoc.setTitle(`${data.documentType === 'receipt' ? 'Receipt' : 'Tax Invoice'} ${data.billingHeaderCode}-${data.documentNumber}`);
  pdfDoc.setCreator('Buddy Glass POS');

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - TOP_MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < BOTTOM_MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - TOP_MARGIN;
    }
  };

  y = drawHeader(page, data, fonts, y);
  y -= 10;
  y = drawCustomerInfo(page, data, fonts, y);
  y -= 10;
  y = drawColumnHeaders(page, fonts, y);

  for (const item of data.items) {
    ensureSpace(20);
    y = drawLineItem(page, item, fonts, y);
  }

  ensureSpace(120);
  y = drawTotals(page, data, fonts, y);

  y -= 15;
  ensureSpace(20);
  const thankYouText = data.documentType === 'receipt' ? 'ขอบคุณที่ใช้บริการ' : 'ขอบคุณที่ใช้บริการ';
  page.drawText(thankYouText, {
    x: LEFT_MARGIN,
    y,
    size: 9,
    font: fonts.regular,
    color: rgb(0.4, 0.4, 0.4),
  });

  return pdfDoc.save();
}

function drawHeader(page: PDFPage, data: ReceiptData, fonts: FontSet, startY: number): number {
  let y = startY;

  page.drawText(data.billingCompanyName, {
    x: LEFT_MARGIN,
    y,
    size: 18,
    font: fonts.bold,
    color: rgb(0.1, 0.1, 0.1),
  });
  y -= 28;

  const docTypeLabel = data.documentType === 'receipt' ? 'ใบเสร็จรับเงิน' : 'ใบกำกับภาษี';
  page.drawText(docTypeLabel, {
    x: LEFT_MARGIN,
    y,
    size: 14,
    font: fonts.bold,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 22;

  page.drawText(`เลขที่ ${data.billingHeaderCode}-${data.documentNumber}`, {
    x: LEFT_MARGIN,
    y,
    size: 10,
    font: fonts.regular,
  });

  const dateText = `วันที่ ${data.issuedAt}`;
  const dateWidth = fonts.regular.widthOfTextAtSize(dateText, 10);
  page.drawText(dateText, {
    x: PAGE_WIDTH - RIGHT_MARGIN - dateWidth,
    y,
    size: 10,
    font: fonts.regular,
  });
  y -= 15;

  return y;
}

function drawCustomerInfo(page: PDFPage, data: ReceiptData, fonts: FontSet, startY: number): number {
  let y = startY;
  const labelX = LEFT_MARGIN;
  const valueX = LEFT_MARGIN + 120;

  page.drawText('ชื่อผู้เสียภาษี', { x: labelX, y, size: 9, font: fonts.bold });
  page.drawText(data.taxpayerName, { x: valueX, y, size: 9, font: fonts.regular });
  y -= 14;

  page.drawText('ที่อยู่', { x: labelX, y, size: 9, font: fonts.bold });
  page.drawText(data.taxpayerAddress, { x: valueX, y, size: 9, font: fonts.regular });
  y -= 14;

  page.drawText('เลขประจำตัวผู้เสียภาษี', { x: labelX, y, size: 9, font: fonts.bold });
  page.drawText(data.taxpayerTaxId ?? '-', { x: valueX, y, size: 9, font: fonts.regular });
  y -= 14;

  return y;
}

function drawColumnHeaders(page: PDFPage, fonts: FontSet, startY: number): number {
  let y = startY;

  const columns = {
    description: LEFT_MARGIN,
    rightEye: LEFT_MARGIN + 180,
    leftEye: LEFT_MARGIN + 230,
    qty: LEFT_MARGIN + 280,
    total: LEFT_MARGIN + 330,
  };

  page.drawRectangle({
    x: LEFT_MARGIN,
    y: y - 16,
    width: CONTENT_WIDTH,
    height: 18,
    color: rgb(0.93, 0.93, 0.93),
  });

  const headerSize = 8;
  page.drawText('รายละเอียด', { x: columns.description, y: y - 12, size: headerSize, font: fonts.bold });
  page.drawText('ค่าสายตาขวา', { x: columns.rightEye, y: y - 12, size: headerSize, font: fonts.bold });
  page.drawText('ค่าสายตาซ้าย', { x: columns.leftEye, y: y - 12, size: headerSize, font: fonts.bold });
  page.drawText('จำนวน', { x: columns.qty, y: y - 12, size: headerSize, font: fonts.bold });

  const totalLabel = 'ยอดรวม';
  const totalLabelWidth = fonts.bold.widthOfTextAtSize(totalLabel, headerSize);
  page.drawText(totalLabel, { x: PAGE_WIDTH - RIGHT_MARGIN - totalLabelWidth, y: y - 12, size: headerSize, font: fonts.bold });

  y -= 18;
  return y;
}

function drawLineItem(page: PDFPage, item: ReceiptLineItem, fonts: FontSet, startY: number): number {
  let y = startY;

  const columns = {
    description: LEFT_MARGIN,
    rightEye: LEFT_MARGIN + 180,
    leftEye: LEFT_MARGIN + 230,
    qty: LEFT_MARGIN + 280,
    total: LEFT_MARGIN + 330,
  };

  const itemSize = 9;

  page.drawText(item.description, { x: columns.description, y, size: itemSize, font: fonts.regular });
  page.drawText(item.rightEyePrescription ?? '', { x: columns.rightEye, y, size: itemSize, font: fonts.regular });
  page.drawText(item.leftEyePrescription ?? '', { x: columns.leftEye, y, size: itemSize, font: fonts.regular });
  page.drawText(String(item.quantity), { x: columns.qty, y, size: itemSize, font: fonts.regular });

  const totalStr = item.lineTotal.toFixed(2);
  const totalWidth = fonts.regular.widthOfTextAtSize(totalStr, itemSize);
  page.drawText(totalStr, { x: PAGE_WIDTH - RIGHT_MARGIN - totalWidth, y, size: itemSize, font: fonts.regular });

  y -= 16;
  return y;
}

function drawTotals(page: PDFPage, data: ReceiptData, fonts: FontSet, startY: number): number {
  let y = startY;
  const labelX = PAGE_WIDTH - RIGHT_MARGIN - 180;
  const valueRight = PAGE_WIDTH - RIGHT_MARGIN;
  const fontSize = 9;

  page.drawLine({
    start: { x: labelX, y: y + 5 },
    end: { x: valueRight, y: y + 5 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });

  const rows: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Subtotal', value: data.subtotal.toFixed(2) },
    {
      label: data.discountType === 'percent' ? `Discount (${data.discountValue}%)` : 'Discount',
      value: `-${data.discountAmount.toFixed(2)}`,
    },
  ];

  if (data.vatEnabled) {
    rows.push({ label: `VAT (${data.vatRate}%)`, value: data.vatAmount.toFixed(2) });
  }

  for (const row of rows) {
    page.drawText(row.label, { x: labelX, y, size: fontSize, font: fonts.regular });
    const vw = fonts.regular.widthOfTextAtSize(row.value, fontSize);
    page.drawText(row.value, { x: valueRight - vw, y, size: fontSize, font: fonts.regular });
    y -= 14;
  }

  page.drawLine({
    start: { x: labelX, y: y + 5 },
    end: { x: valueRight, y: y + 5 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });

  y -= 5;

  const grandTotalStr = data.totalAmount.toFixed(2);
  page.drawText('Grand Total', { x: labelX, y, size: 11, font: fonts.bold });
  const gtw = fonts.bold.widthOfTextAtSize(grandTotalStr, 11);
  page.drawText(grandTotalStr, { x: valueRight - gtw, y, size: 11, font: fonts.bold });

  y -= 20;
  return y;
}
