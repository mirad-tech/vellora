#pragma once

#include <QByteArray>
#include <QtEndian>

namespace imageDecode {

// Qt 6.8.3's WebP handler requires a 40-byte peek (the size of
// WebPBitstreamFeatures), although a complete lossless WebP can be 36 bytes.
// Supply a padded decoding view only after the entire declared RIFF is present.
// Padding is outside the RIFF payload: authorization and the original file/data
// remain unchanged, and a truncated declared payload is never filled in.
// https://github.com/qt/qtimageformats/blob/v6.8.3/src/plugins/imageformats/webp/qwebphandler.cpp
inline QByteArray inputBytes(const QByteArray& bytes) {
  if (bytes.size() < 20 || bytes.size() >= 40 || !bytes.startsWith("RIFF") ||
      bytes.mid(8, 4) != QByteArrayLiteral("WEBP")) return bytes;
  const quint64 declared = quint64(qFromLittleEndian<quint32>(
      reinterpret_cast<const uchar*>(bytes.constData() + 4))) + 8;
  if (declared < 20 || declared > quint64(bytes.size())) return bytes;
  QByteArray view = bytes;
  view.append(QByteArray(40 - bytes.size(), '\0'));
  return view;
}

}  // namespace imageDecode
