#!/usr/bin/env swift

import EventKit
import Foundation

enum HelperError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let value): return value
    }
  }
}

let store = EKEventStore()
let iso8601 = ISO8601DateFormatter()
iso8601.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let iso8601Fallback = ISO8601DateFormatter()
iso8601Fallback.formatOptions = [.withInternetDateTime]

func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw HelperError.message(message) }
}

func string(_ value: Any?, _ name: String, maximum: Int, allowEmpty: Bool = false) throws -> String {
  guard let result = value as? String else { throw HelperError.message("\(name) must be a string") }
  try require(allowEmpty || !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(name) must be a non-empty string")
  try require(result.count <= maximum, "\(name) exceeds \(maximum) characters")
  return result
}

func date(_ value: Any?, _ name: String) throws -> Date {
  let raw = try string(value, name, maximum: 100)
  guard let result = iso8601.date(from: raw) ?? iso8601Fallback.date(from: raw) else {
    throw HelperError.message("\(name) must be an ISO date string")
  }
  return result
}

func iso(_ value: Date?) -> Any {
  value.map { iso8601.string(from: $0) } ?? NSNull()
}

func integer(_ value: Any?, _ name: String, fallback: Int, minimum: Int, maximum: Int) throws -> Int {
  if value == nil { return fallback }
  guard let number = value as? NSNumber else { throw HelperError.message("\(name) must be an integer") }
  let result = number.intValue
  try require(number.doubleValue == Double(result) && result >= minimum && result <= maximum,
              "\(name) must be an integer from \(minimum) to \(maximum)")
  return result
}

func payload(_ raw: String) throws -> [String: Any] {
  guard let data = raw.data(using: .utf8),
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw HelperError.message("payload must be an object")
  }
  return value
}

func requestAccess(_ entity: EKEntityType) throws {
  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  var accessError: Error?
  if #available(macOS 14.0, *) {
    let completion: (Bool, Error?) -> Void = { allowed, error in
      granted = allowed
      accessError = error
      semaphore.signal()
    }
    if entity == .event {
      store.requestFullAccessToEvents(completion: completion)
    } else {
      store.requestFullAccessToReminders(completion: completion)
    }
  } else {
    store.requestAccess(to: entity) { allowed, error in
      granted = allowed
      accessError = error
      semaphore.signal()
    }
  }
  _ = semaphore.wait(timeout: .now() + 30)
  if let accessError { throw accessError }
  try require(granted, entity == .event ? "calendar access denied" : "reminder access denied")
}

func eventCalendars(_ target: String, forCreate: Bool = false) throws -> [EKCalendar] {
  let calendars = store.calendars(for: .event)
  if target == "*" { return calendars }
  if target == "default", let calendar = store.defaultCalendarForNewEvents { return [calendar] }
  if let calendar = calendars.first(where: { $0.title == target }) { return [calendar] }
  if forCreate && target == "default", let calendar = calendars.first { return [calendar] }
  throw HelperError.message("calendar not found: \(target)")
}

func reminderCalendars(_ target: String, forCreate: Bool = false) throws -> [EKCalendar] {
  let calendars = store.calendars(for: .reminder)
  if target == "*" { return calendars }
  if target == "default", let calendar = store.defaultCalendarForNewReminders() { return [calendar] }
  if let calendar = calendars.first(where: { $0.title == target }) { return [calendar] }
  if forCreate && target == "default", let calendar = calendars.first { return [calendar] }
  throw HelperError.message("reminder list not found: \(target)")
}

func eventItem(_ event: EKEvent) -> [String: Any] {
  [
    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
    "calendar": event.calendar.title,
    "title": event.title ?? "",
    "startAt": iso(event.startDate),
    "endAt": iso(event.endDate),
    "allDay": event.isAllDay,
    "location": event.location ?? "",
    "notes": event.notes ?? ""
  ]
}

func dueDate(_ reminder: EKReminder) -> Date? {
  guard let components = reminder.dueDateComponents else { return nil }
  return components.calendar?.date(from: components) ?? Calendar.current.date(from: components)
}

func reminderItem(_ reminder: EKReminder) -> [String: Any] {
  [
    "id": reminder.calendarItemIdentifier,
    "list": reminder.calendar.title,
    "title": reminder.title ?? "",
    "dueAt": iso(dueDate(reminder)),
    "completed": reminder.isCompleted,
    "priority": reminder.priority,
    "flagged": reminder.priority == 1,
    "notes": reminder.notes ?? ""
  ]
}

func fetchReminders(_ calendars: [EKCalendar]) throws -> [EKReminder] {
  let semaphore = DispatchSemaphore(value: 0)
  var result: [EKReminder] = []
  store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
    result = reminders ?? []
    semaphore.signal()
  }
  guard semaphore.wait(timeout: .now() + 30) == .success else {
    throw HelperError.message("reminder query timed out")
  }
  return result
}

func findEvent(_ identifier: String, calendarName: String) throws -> EKEvent {
  if let event = store.event(withIdentifier: identifier),
     calendarName == "*" || event.calendar.title == calendarName {
    return event
  }
  throw HelperError.message("calendar event not found: \(identifier)")
}

func findReminder(_ identifier: String, listName: String) throws -> EKReminder {
  let reminders = try fetchReminders(try reminderCalendars(listName))
  guard let reminder = reminders.first(where: { $0.calendarItemIdentifier == identifier }) else {
    throw HelperError.message("reminder not found: \(identifier)")
  }
  return reminder
}

func reminderDueComponents(_ value: Date) -> DateComponents {
  var components = Calendar.current.dateComponents(
    [.calendar, .timeZone, .year, .month, .day, .hour, .minute, .second],
    from: value
  )
  components.calendar = Calendar.current
  components.timeZone = TimeZone.current
  return components
}

func run(_ action: String, target: String, body: [String: Any]) throws -> Any {
  if action.hasPrefix("calendar_") || action == "poll" { try requestAccess(.event) }
  if action.hasPrefix("reminder_") || action == "poll" { try requestAccess(.reminder) }

  switch action {
  case "calendar_list":
    let from = try body["from"].map { try date($0, "payload.from") } ?? Date()
    let to = try body["to"].map { try date($0, "payload.to") } ?? from.addingTimeInterval(86_400)
    let limit = try integer(body["limit"], "payload.limit", fallback: 50, minimum: 1, maximum: 500)
    let calendars = try eventCalendars(target)
    let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
      .sorted { $0.startDate < $1.startDate }
      .prefix(limit)
      .map(eventItem)
    return ["events": events]

  case "calendar_create":
    let calendar = try eventCalendars(target, forCreate: true).first!
    let start = try date(body["start"], "payload.start")
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = try string(body["title"], "payload.title", maximum: 1000)
    event.startDate = start
    event.endDate = try body["end"].map { try date($0, "payload.end") } ?? start.addingTimeInterval(3600)
    if body.keys.contains("location") { event.location = try string(body["location"], "payload.location", maximum: 5000, allowEmpty: true) }
    if body.keys.contains("notes") { event.notes = try string(body["notes"], "payload.notes", maximum: 40000, allowEmpty: true) }
    if body.keys.contains("allDay") {
      guard let value = body["allDay"] as? Bool else { throw HelperError.message("payload.allDay must be a boolean") }
      event.isAllDay = value
    }
    try store.save(event, span: .thisEvent, commit: true)
    return ["created": true, "id": event.eventIdentifier ?? event.calendarItemIdentifier,
            "calendar": calendar.title, "startAt": iso(event.startDate), "endAt": iso(event.endDate)]

  case "calendar_update":
    let fields = Set(["title", "start", "end", "location", "notes", "allDay"])
    try require(!fields.isDisjoint(with: body.keys), "calendar_update requires at least one mutable field")
    let event = try findEvent(target, calendarName: body["calendar"] as? String ?? "*")
    if body.keys.contains("title") { event.title = try string(body["title"], "payload.title", maximum: 1000) }
    if body.keys.contains("start") { event.startDate = try date(body["start"], "payload.start") }
    if body.keys.contains("end") { event.endDate = try date(body["end"], "payload.end") }
    if body.keys.contains("location") { event.location = try string(body["location"], "payload.location", maximum: 5000, allowEmpty: true) }
    if body.keys.contains("notes") { event.notes = try string(body["notes"], "payload.notes", maximum: 40000, allowEmpty: true) }
    if body.keys.contains("allDay") {
      guard let value = body["allDay"] as? Bool else { throw HelperError.message("payload.allDay must be a boolean") }
      event.isAllDay = value
    }
    try store.save(event, span: .thisEvent, commit: true)
    return ["updated": true, "event": eventItem(event)]

  case "calendar_delete":
    let event = try findEvent(target, calendarName: body["calendar"] as? String ?? "*")
    let calendar = event.calendar.title
    try store.remove(event, span: .thisEvent, commit: true)
    return ["deleted": true, "id": target, "calendar": calendar]

  case "reminder_list":
    let includeCompleted = body["completed"] as? Bool == true
    let limit = try integer(body["limit"], "payload.limit", fallback: 100, minimum: 1, maximum: 500)
    let reminders = try fetchReminders(try reminderCalendars(target))
      .filter { includeCompleted || !$0.isCompleted }
      .sorted { (dueDate($0) ?? .distantFuture) < (dueDate($1) ?? .distantFuture) }
      .prefix(limit)
      .map(reminderItem)
    return ["reminders": reminders]

  case "reminder_create":
    let calendar = try reminderCalendars(target, forCreate: true).first!
    let reminder = EKReminder(eventStore: store)
    reminder.calendar = calendar
    reminder.title = try string(body["title"], "payload.title", maximum: 1000)
    if body.keys.contains("notes") { reminder.notes = try string(body["notes"], "payload.notes", maximum: 40000, allowEmpty: true) }
    if let value = body["dueAt"], !(value is NSNull) { reminder.dueDateComponents = reminderDueComponents(try date(value, "payload.dueAt")) }
    reminder.priority = try integer(body["priority"], "payload.priority", fallback: 0, minimum: 0, maximum: 9)
    if let flagged = body["flagged"] {
      guard let value = flagged as? Bool else { throw HelperError.message("payload.flagged must be a boolean") }
      if value && body["priority"] == nil { reminder.priority = 1 }
      if !value && body["priority"] == nil { reminder.priority = 0 }
    }
    try store.save(reminder, commit: true)
    return ["created": true, "id": reminder.calendarItemIdentifier, "list": calendar.title, "dueAt": iso(dueDate(reminder))]

  case "reminder_complete":
    let reminder = try findReminder(target, listName: body["list"] as? String ?? "*")
    reminder.isCompleted = true
    reminder.completionDate = Date()
    try store.save(reminder, commit: true)
    return ["completed": true, "id": target, "list": reminder.calendar.title]

  case "reminder_update":
    let fields = Set(["title", "dueAt", "notes", "priority", "completed", "flagged"])
    try require(!fields.isDisjoint(with: body.keys), "reminder_update requires at least one mutable field")
    let reminder = try findReminder(target, listName: body["list"] as? String ?? "*")
    if body.keys.contains("title") { reminder.title = try string(body["title"], "payload.title", maximum: 1000) }
    if body.keys.contains("dueAt") {
      reminder.dueDateComponents = body["dueAt"] is NSNull ? nil : reminderDueComponents(try date(body["dueAt"], "payload.dueAt"))
    }
    if body.keys.contains("notes") { reminder.notes = try string(body["notes"], "payload.notes", maximum: 40000, allowEmpty: true) }
    if body.keys.contains("priority") { reminder.priority = try integer(body["priority"], "payload.priority", fallback: 0, minimum: 0, maximum: 9) }
    if body.keys.contains("completed") {
      guard let value = body["completed"] as? Bool else { throw HelperError.message("payload.completed must be a boolean") }
      reminder.isCompleted = value
      reminder.completionDate = value ? Date() : nil
    }
    if body.keys.contains("flagged") {
      guard let value = body["flagged"] as? Bool else { throw HelperError.message("payload.flagged must be a boolean") }
      if body["priority"] == nil { reminder.priority = value ? 1 : 0 }
    }
    try store.save(reminder, commit: true)
    return ["updated": true, "reminder": reminderItem(reminder)]

  case "reminder_delete":
    let reminder = try findReminder(target, listName: body["list"] as? String ?? "*")
    let list = reminder.calendar.title
    try store.remove(reminder, commit: true)
    return ["deleted": true, "id": target, "list": list]

  case "poll":
    let now = try date(body["now"], "payload.now")
    let until = try date(body["until"], "payload.until")
    let calendarName = body["calendar"] as? String ?? "*"
    let listName = body["list"] as? String ?? "*"
    let limit = try integer(body["limit"], "payload.limit", fallback: 200, minimum: 1, maximum: 200)
    let previousCalendar = Set(body["previousCalendarIds"] as? [String] ?? [])
    let previousReminders = Set(body["previousReminderIds"] as? [String] ?? [])
    let currentEvents = store.events(matching: store.predicateForEvents(
      withStart: now, end: until, calendars: try eventCalendars(calendarName)
    )).prefix(limit).map(eventItem)
    var knownEvents: [[String: Any]] = []
    for identifier in previousCalendar where knownEvents.count < limit {
      if let event = store.event(withIdentifier: identifier),
         calendarName == "*" || event.calendar.title == calendarName,
         !currentEvents.contains(where: { $0["id"] as? String == identifier }) {
        knownEvents.append(eventItem(event))
      }
    }
    let allReminders = try fetchReminders(try reminderCalendars(listName))
    let dueReminders = allReminders.filter {
      !$0.isCompleted && dueDate($0).map { $0 <= until } == true
    }.prefix(limit).map(reminderItem)
    let dueIds = Set(dueReminders.compactMap { $0["id"] as? String })
    let knownReminders = allReminders.filter {
      previousReminders.contains($0.calendarItemIdentifier) && !dueIds.contains($0.calendarItemIdentifier)
    }.prefix(limit).map(reminderItem)
    return ["calendar": currentEvents, "reminders": dueReminders,
            "knownCalendar": knownEvents, "knownReminders": knownReminders]

  default:
    throw HelperError.message("unsupported action: \(action)")
  }
}

do {
  let arguments = CommandLine.arguments
  try require(arguments.count == 4, "usage: macos-life-eventkit.swift <action> <target> <payload-json>")
  let result = try run(arguments[1], target: arguments[2], body: try payload(arguments[3]))
  let data = try JSONSerialization.data(withJSONObject: result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
