// amazon-label-tool/functions/api/process.js

// IMPORTANT: To use an external library like pdf-lib,
// we must have a package.json file. This setup assumes a Git-based deployment
// where Cloudflare can see package.json and install dependencies.

// The actual import will be handled by Cloudflare's build system.
// We can't use a relative path here.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }

    if (context.request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        const formData = await context.request.formData();
        const file = formData.get('file');
        const textToRemove = formData.get('textToRemove') || '';
        const addMadeInChina = formData.get('addMadeInChina') === 'true';
        const fontSize = parseInt(formData.get('fontSize')) || 8;

        if (!file || typeof file === 'string') {
            return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400 });
        }

        const pdfBytes = await file.arrayBuffer();
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        const pages = pdfDoc.getPages();
        for (const page of pages) {
            const { width, height } = page.getSize();
            // This is a workaround as pdf-lib doesn't have a direct text extraction with coordinates.
            // It's a simplified model but works for structured PDFs like Amazon labels.
            const textItems = await getTextItemsWithCoords(page);

            const labels = findLabelsByFnsku(textItems, height);

            for (const label of labels) {
                if (textToRemove) {
                    const removeAreas = findTextInLabel(label, textToRemove);
                    for (const area of removeAreas) {
                        page.drawRectangle({
                            x: area.x, y: area.y,
                            width: area.width, height: area.height,
                            color: rgb(1, 1, 1),
                        });
                    }
                }

                if (addMadeInChina) {
                    const text = 'Made in China';
                    const textWidth = font.widthOfTextAtSize(text, fontSize);
                    page.drawText(text, {
                        x: label.box.x + (label.box.width - textWidth) / 2,
                        y: label.box.y + 2, // 2pt margin from bottom
                        size: fontSize, font, color: rgb(0, 0, 0),
                    });
                }
            }
        }

        const modifiedPdfBytes = await pdfDoc.save();

        return new Response(modifiedPdfBytes, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="processed_${file.name}"`,
                'Access-Control-Allow-Origin': '*',
            },
        });

    } catch (error) {
        console.error('Error processing PDF:', error);
        // Provide a more user-friendly error
        return new Response(JSON.stringify({ error: `PDF处理失败，可能是文件格式不支持或内容无法解析。` }), { status: 500 });
    }
}

// --- Helper Functions ---
// These functions contain the core logic for finding and manipulating PDF content.
async function getTextItemsWithCoords(page) {
    // This is a challenging task in pure JS. We use a simplified regex-based approach on the content stream.
    // This is not foolproof but works for the known structure of Amazon labels.
    const contentStream = page.node.Content.toString();
    const textBlocks = contentStream.match(/BT(.*?)ET/g) || [];
    const textItems = [];
    for (const block of textBlocks) {
        const tmMatch = block.match(/(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+Tm/);
        const tjMatch = block.match(/\((.*?)\)\s*Tj/);
        if (tmMatch && tjMatch) {
            const matrix = tmMatch.slice(1).map(parseFloat);
            const text = tjMatch[1];
            const x = matrix[4];
            const y = matrix[5];
            // Heuristic for width and height based on font size (usually in the matrix)
            const fontSize = matrix[0] > 0 ? matrix[0] : matrix[3]; // Font size can be in a or d
            const approxWidth = text.length * fontSize * 0.55; // Heuristic
            const approxHeight = fontSize;
            textItems.push({ str: text, box: { x, y, width: approxWidth, height: approxHeight } });
        }
    }
    return textItems;
}

function findLabelsByFnsku(items, pageHeight) {
    const FNSKU_REGEX = /^(X00|B0)[A-Z0-9]{8,10}$/;
    const transformedItems = items.map(item => ({...item, box: {...item.box, y: pageHeight - item.box.y - item.box.height }}));
    const anchors = transformedItems.filter(item => FNSKU_REGEX.test(item.str.trim()));

    return anchors.map(anchor => {
        const searchBox = { minX: anchor.box.x - 120, maxX: anchor.box.x + 120, minY: anchor.box.y - 60, maxY: anchor.box.y + 60 };
        const labelItems = transformedItems.filter(item => { const itemCenterY = item.box.y + item.box.height / 2; return item.box.x > searchBox.minX && item.box.x < searchBox.maxX && itemCenterY > searchBox.minY && itemCenterY < searchBox.maxY; });
        const labelBox = labelItems.reduce((box, item) => ({ minX: Math.min(box.minX, item.box.x), maxX: Math.max(box.maxX, item.box.x + item.box.width), minY: Math.min(box.minY, item.box.y), maxY: Math.max(box.maxY, item.box.y + item.box.height) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        return { box: { x: labelBox.minX, y: pageHeight - labelBox.maxY, width: labelBox.maxX - labelBox.minX, height: labelBox.maxY - labelBox.minY }, items: labelItems };
    });
}

function findTextInLabel(label, searchText) {
    // This is a simplified search that unions the boxes of items containing parts of the search text.
    const cleanSearchText = searchText.replace(/\s+/g, '').toLowerCase();
    const matchedItems = label.items.filter(item => cleanSearchText.includes(item.str.replace(/\s+/g, '').toLowerCase()));
    
    if (matchedItems.length === 0) return [];

    const unionBox = matchedItems.reduce((box, item) => ({
         minX: Math.min(box.minX, item.box.x), maxX: Math.max(box.maxX, item.box.x + item.box.width),
         minY: Math.min(box.minY, item.box.y), maxY: Math.max(box.maxY, item.box.y + item.box.height)
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    return [{
        x: unionBox.minX - 2, y: label.box.height + label.box.y - unionBox.maxY - 2,
        width: unionBox.maxX - unionBox.minX + 4, height: unionBox.maxY - unionBox.minY + 4
    }];
}