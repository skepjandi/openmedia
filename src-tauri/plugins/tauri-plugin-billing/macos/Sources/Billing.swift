import Foundation
import RevenueCat

// The macOS twin of `ios/Sources/BillingPlugin.swift`. Tauri's Swift plugin API is iOS-only, so
// Rust reaches this through three C functions instead: a request that answers with JSON, a call
// that frees the answer, and a listener that receives entitlement changes. The commands, their
// arguments and their answers are the same as on iOS; the Rust side is `src/macos.rs`.

private struct Snapshot: Encodable {
  let active: Bool
  let productId: String?
  let inTrial: Bool
  let expiresAtMs: Int64?
  let willRenew: Bool
}

private struct SnapshotEvent: Encodable {
  let type = "snapshot"
  let active: Bool
  let productId: String?
  let inTrial: Bool
  let expiresAtMs: Int64?
  let willRenew: Bool

  init(_ snapshot: Snapshot) {
    active = snapshot.active
    productId = snapshot.productId
    inTrial = snapshot.inTrial
    expiresAtMs = snapshot.expiresAtMs
    willRenew = snapshot.willRenew
  }
}

private struct PackageView: Encodable {
  let id: String
  let kind: String
  let productId: String
  let price: String
  let trialDays: Int?
}

private struct OfferingsView: Encodable {
  let packages: [PackageView]
}

private struct PurchaseView: Encodable {
  let outcome: String
  let snapshot: Snapshot?
}

private struct ConfigureArgs: Decodable {
  let apiKey: String
  let entitlementId: String
}

private struct PurchaseArgs: Decodable {
  let packageId: String
}

private struct Failure: Error {
  let message: String
}

private let purchaseFailed = "purchase failed"
private let notConfigured = "billing is not configured"

private final class State: @unchecked Sendable {
  private let lock = NSLock()
  private var _entitlementId: String?
  private var _listener: (@convention(c) (UnsafePointer<CChar>) -> Void)?
  private var _streamTask: Task<Void, Never>?

  var entitlementId: String? {
    lock.lock()
    defer { lock.unlock() }
    return _entitlementId
  }

  var listener: (@convention(c) (UnsafePointer<CChar>) -> Void)? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return _listener
    }
    set {
      lock.lock()
      _listener = newValue
      lock.unlock()
    }
  }

  func configure(entitlementId: String, startStream: () -> Task<Void, Never>) {
    lock.lock()
    defer { lock.unlock() }
    _entitlementId = entitlementId
    if _streamTask == nil {
      _streamTask = startStream()
    }
  }
}

private let state = State()

private final class Answer: @unchecked Sendable {
  var json = #"{"error":"billing failed"}"#
}

private func encode<T: Encodable>(_ value: T) -> String {
  guard let data = try? JSONEncoder().encode(value) else { return "null" }
  return String(decoding: data, as: UTF8.self)
}

private func ok<T: Encodable>(_ value: T) -> String {
  #"{"ok":"# + encode(value) + "}"
}

private func fail(_ message: String) -> String {
  #"{"error":"# + encode(message) + "}"
}

private func snapshot(_ info: CustomerInfo, _ entitlementId: String) -> Snapshot {
  let entitlement = info.entitlements[entitlementId]
  return Snapshot(
    active: entitlement?.isActive == true,
    productId: entitlement?.productIdentifier,
    inTrial: entitlement?.periodType == .trial,
    expiresAtMs: entitlement?.expirationDate.map { Int64($0.timeIntervalSince1970 * 1000) },
    willRenew: entitlement?.willRenew == true)
}

private func trialDays(_ product: StoreProduct) async -> Int? {
  guard let discount = product.introductoryDiscount, discount.paymentMode == .freeTrial else {
    return nil
  }
  let status = await Purchases.shared.checkTrialOrIntroDiscountEligibility(product: product)
  guard status == .eligible else { return nil }
  let period = discount.subscriptionPeriod
  let perUnit: Int
  switch period.unit {
  case .day: perUnit = 1
  case .week: perUnit = 7
  case .month: perUnit = 30
  case .year: perUnit = 365
  @unknown default: return nil
  }
  return perUnit * period.value
}

private func configure(_ payload: Data) throws -> String {
  let args = try JSONDecoder().decode(ConfigureArgs.self, from: payload)
  guard !args.apiKey.isEmpty, !args.entitlementId.isEmpty else {
    throw Failure(message: notConfigured)
  }
  if !Purchases.isConfigured {
    Purchases.configure(
      with: Configuration.Builder(withAPIKey: args.apiKey)
        .with(storeKitVersion: .storeKit2)
        .build())
  }
  state.configure(entitlementId: args.entitlementId) {
    Task {
      for await info in Purchases.shared.customerInfoStream {
        guard let entitlementId = state.entitlementId, let listener = state.listener else {
          continue
        }
        encode(SnapshotEvent(snapshot(info, entitlementId))).withCString { listener($0) }
      }
    }
  }
  return ok(true)
}

private func customerInfo() async throws -> String {
  guard let entitlementId = state.entitlementId, Purchases.isConfigured else {
    throw Failure(message: notConfigured)
  }
  do {
    return ok(snapshot(try await Purchases.shared.customerInfo(), entitlementId))
  } catch {
    throw Failure(message: "could not read purchase status")
  }
}

private func offerings() async throws -> String {
  guard Purchases.isConfigured else { throw Failure(message: notConfigured) }
  do {
    let offerings = try await Purchases.shared.offerings()
    guard let offering = offerings.current else { return ok(OfferingsView(packages: [])) }
    let ordered: [(Package?, String, String)] = [
      (offering.lifetime, "$rc_lifetime", "lifetime"),
      (offering.annual, "$rc_annual", "yearly"),
      (offering.monthly, "$rc_monthly", "monthly"),
    ]
    var packages: [PackageView] = []
    for (package, id, kind) in ordered {
      guard let package else { continue }
      let product = package.storeProduct
      packages.append(
        PackageView(
          id: id,
          kind: kind,
          productId: product.productIdentifier,
          price: product.localizedPriceString,
          trialDays: await trialDays(product)))
    }
    return ok(OfferingsView(packages: packages))
  } catch {
    throw Failure(message: "could not load plans")
  }
}

private func purchase(_ payload: Data) async throws -> String {
  let args = try JSONDecoder().decode(PurchaseArgs.self, from: payload)
  guard let entitlementId = state.entitlementId, Purchases.isConfigured else {
    throw Failure(message: notConfigured)
  }
  do {
    let offerings = try await Purchases.shared.offerings()
    guard
      let package = offerings.current?.availablePackages.first(where: {
        $0.identifier == args.packageId
      })
    else {
      throw Failure(message: "plan not available")
    }
    let result = try await Purchases.shared.purchase(package: package)
    if result.userCancelled {
      return ok(PurchaseView(outcome: "cancelled", snapshot: nil))
    }
    return ok(
      PurchaseView(outcome: "purchased", snapshot: snapshot(result.customerInfo, entitlementId)))
  } catch let error as Failure {
    throw error
  } catch let error as ErrorCode {
    switch error {
    case .purchaseCancelledError: return ok(PurchaseView(outcome: "cancelled", snapshot: nil))
    case .paymentPendingError: return ok(PurchaseView(outcome: "pending", snapshot: nil))
    default: throw Failure(message: purchaseFailed)
    }
  } catch {
    throw Failure(message: purchaseFailed)
  }
}

private func restore() async throws -> String {
  guard let entitlementId = state.entitlementId, Purchases.isConfigured else {
    throw Failure(message: notConfigured)
  }
  do {
    return ok(snapshot(try await Purchases.shared.restorePurchases(), entitlementId))
  } catch {
    throw Failure(message: "could not restore purchases")
  }
}

private func handle(_ command: String, _ payload: Data) async -> String {
  do {
    switch command {
    case "configure": return try configure(payload)
    case "customerInfo": return try await customerInfo()
    case "offerings": return try await offerings()
    case "purchase": return try await purchase(payload)
    case "restore": return try await restore()
    default: return fail("unknown billing command")
    }
  } catch let error as Failure {
    return fail(error.message)
  } catch {
    return fail("billing failed")
  }
}

/// Receives each entitlement change as a JSON `{"type":"snapshot", ...}` string, on a Swift
/// concurrency thread. The string is only valid during the call.
@_cdecl("om_billing_set_listener")
public func omBillingSetListener(_ callback: @escaping @convention(c) (UnsafePointer<CChar>) -> Void)
{
  state.listener = callback
}

/// Runs one command and waits for its answer: `{"ok": ...}` or `{"error": "..."}`. Blocks the
/// calling thread, so it must not be the main thread (a purchase sheet needs it). Free the
/// answer with `om_billing_free`.
@_cdecl("om_billing_request")
public func omBillingRequest(
  _ command: UnsafePointer<CChar>, _ payload: UnsafePointer<CChar>
) -> UnsafeMutablePointer<CChar> {
  let command = String(cString: command)
  let payload = Data(String(cString: payload).utf8)
  let answer = Answer()
  let done = DispatchSemaphore(value: 0)
  Task {
    answer.json = await handle(command, payload)
    done.signal()
  }
  done.wait()
  return strdup(answer.json)
}

@_cdecl("om_billing_free")
public func omBillingFree(_ pointer: UnsafeMutablePointer<CChar>) {
  free(pointer)
}
