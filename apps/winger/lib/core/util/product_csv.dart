/// CSV helpers for supplier product bulk import.
library;

import 'dart:convert';
import 'dart:typed_data';

const productCsvTemplate =
    'name,brand,price,stock,category,model,color,size,battery,weight,description,imageUrl\n'
    'Brother XM3700 Sewing Machine,Brother,116.99,10,Home,XM3700,White,Standard,,,37 built-in stitches,\n'
    'Example Desk Lamp,Atlas,49.99,25,Home,DL-100,Black,Standard,,,Adjustable LED desk lamp,\n';

/// UTF-8 bytes with BOM so Excel on Windows opens the template correctly.
Uint8List productCsvTemplateBytes() {
  return Uint8List.fromList([0xEF, 0xBB, 0xBF, ...utf8.encode(productCsvTemplate)]);
}

/// Decode CSV bytes from UTF-8, UTF-16, or Windows-1252-ish latin1.
String decodeCsvBytes(List<int> bytes) {
  if (bytes.isEmpty) {
    throw const FormatException('CSV file is empty');
  }

  // UTF-8 BOM
  if (bytes.length >= 3 &&
      bytes[0] == 0xEF &&
      bytes[1] == 0xBB &&
      bytes[2] == 0xBF) {
    return utf8.decode(bytes.sublist(3));
  }
  // UTF-16 LE BOM (common when Excel "CSV" is re-saved on Windows)
  if (bytes.length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) {
    return String.fromCharCodes(
      Uint16List.view(Uint8List.fromList(bytes.sublist(2)).buffer),
    );
  }
  // UTF-16 BE BOM
  if (bytes.length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF) {
    final view = bytes.sublist(2);
    final chars = <int>[];
    for (var i = 0; i + 1 < view.length; i += 2) {
      chars.add((view[i] << 8) | view[i + 1]);
    }
    return String.fromCharCodes(chars);
  }

  try {
    return utf8.decode(bytes);
  } on FormatException {
    // Heuristic: lots of NULs → likely UTF-16 LE without BOM
    final nulCount = bytes.where((b) => b == 0).length;
    if (nulCount > bytes.length ~/ 4 && bytes.length.isEven) {
      return String.fromCharCodes(Uint16List.view(Uint8List.fromList(bytes).buffer));
    }
    return latin1.decode(bytes);
  }
}

class ParsedProductCsv {
  const ParsedProductCsv({required this.products, required this.rowErrors});

  final List<Map<String, dynamic>> products;
  final List<String> rowErrors;
}

ParsedProductCsv parseProductCsv(String raw) {
  final normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (normalized.isEmpty) {
    throw const FormatException('CSV file is empty');
  }
  final lines = normalized
      .split('\n')
      .map((line) => line.trimRight())
      .where((line) => line.trim().isNotEmpty)
      .toList();
  if (lines.length < 2) {
    throw const FormatException('CSV needs a header row and at least one product row');
  }

  final headers = _splitCsvLine(lines.first)
      .map((h) => h.trim().toLowerCase())
      .toList();
  if (!headers.contains('name') || !headers.contains('price')) {
    throw const FormatException('CSV must include name and price columns');
  }

  final products = <Map<String, dynamic>>[];
  final rowErrors = <String>[];
  for (var i = 1; i < lines.length; i++) {
    final cells = _splitCsvLine(lines[i]);
    String cell(String key) {
      final index = headers.indexOf(key);
      if (index < 0 || index >= cells.length) return '';
      return cells[index].trim();
    }

    final name = cell('name');
    final price = double.tryParse(cell('price'));
    if (name.isEmpty || price == null) {
      rowErrors.add('Row ${i + 1}: name and numeric price are required');
      continue;
    }

    final stockRaw = cell('stock');
    final stock = stockRaw.isEmpty ? 0 : int.tryParse(stockRaw);
    if (stock == null || stock < 0) {
      rowErrors.add('Row ${i + 1}: stock must be a non-negative integer');
      continue;
    }

    products.add({
      'name': name,
      'brand': cell('brand'),
      'price': price,
      'stock': stock,
      'category': cell('category'),
      'model': cell('model'),
      'color': cell('color'),
      'size': cell('size'),
      'battery': cell('battery'),
      'weight': cell('weight'),
      'description': cell('description'),
      if (cell('imageurl').isNotEmpty) 'imageUrl': cell('imageurl'),
    });
  }

  if (products.isEmpty) {
    final detail = rowErrors.isEmpty
        ? 'No valid product rows found'
        : rowErrors.take(5).join('\n');
    throw FormatException(detail);
  }
  if (products.length > 100) {
    throw const FormatException('Import at most 100 products at a time');
  }
  return ParsedProductCsv(products: products, rowErrors: rowErrors);
}

List<String> _splitCsvLine(String line) {
  final cells = <String>[];
  final buffer = StringBuffer();
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (ch == '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] == '"') {
        buffer.write('"');
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch == ',' && !inQuotes) {
      cells.add(buffer.toString());
      buffer.clear();
      continue;
    }
    buffer.write(ch);
  }
  cells.add(buffer.toString());
  return cells;
}
