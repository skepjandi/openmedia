// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "om-billing-macos",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "om-billing-macos",
            type: .static,
            targets: ["om-billing-macos"]),
    ],
    dependencies: [
        .package(url: "https://github.com/RevenueCat/purchases-ios-spm", from: "5.102.3"),
    ],
    targets: [
        .target(
            name: "om-billing-macos",
            dependencies: [
                .product(name: "RevenueCat", package: "purchases-ios-spm"),
            ],
            path: "Sources")
    ]
)
