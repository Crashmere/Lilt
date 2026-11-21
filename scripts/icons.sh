#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../web/public"
swift - "$PWD" <<'SWIFT'
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let destination = CommandLine.arguments[1]
for (name, size) in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)] {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(red: 40.0/255, green: 43.0/255, blue: 40.0/255, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let scale = CGFloat(size) / 180
    context.scaleBy(x: scale, y: scale)
    context.move(to: CGPoint(x: 53, y: 134)); context.addLine(to: CGPoint(x: 53, y: 53)); context.addLine(to: CGPoint(x: 128, y: 53))
    context.setLineWidth(13); context.setLineCap(.round); context.setLineJoin(.round)
    context.setStrokeColor(red: 245.0/255, green: 240.0/255, blue: 230.0/255, alpha: 1); context.strokePath()
    context.setStrokeColor(red: 212.0/255, green: 119.0/255, blue: 75.0/255, alpha: 1)
    context.setLineWidth(12)
    for (x, top, bottom) in [(85.0, 80.0, 115.0), (108.0, 58.0, 115.0), (131.0, 73.0, 95.0)] {
        context.move(to: CGPoint(x: x, y: 180 - top)); context.addLine(to: CGPoint(x: x, y: 180 - bottom)); context.strokePath()
    }
    let output = CGImageDestinationCreateWithURL(URL(fileURLWithPath: destination + "/" + name) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(output, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(output) else { fatalError("Unable to write icon") }
}
SWIFT
