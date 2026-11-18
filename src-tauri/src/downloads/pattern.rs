//! Batch descriptors: `https://x/img[001-050].jpg` stands for fifty addresses.
//!
//! A group is `[start-end]` or `[start-end:step]` over numbers (zero-padded when `start` has a
//! leading zero) or over single letters (`[a-e]`). Any other bracket stays as written, so an IPv6
//! address or a query like `?ids[]=1` is left alone. Several groups multiply.

use crate::error::{Error, Result};

/// The most addresses one descriptor may stand for.
pub const MAX_EXPANSION: usize = 500;

enum Piece {
    Text(String),
    Group(Vec<String>),
}

fn fail(message: &str) -> Error {
    Error::Download(message.to_owned())
}

fn numeric_values(start: &str, end: &str, step: u64) -> Result<Vec<String>> {
    let (Ok(from), Ok(to)) = (start.parse::<u64>(), end.parse::<u64>()) else {
        return Err(fail("a range number is too large"));
    };
    let width = if start.len() > 1 && start.starts_with('0') {
        start.len()
    } else {
        0
    };
    let count = from.abs_diff(to) / step + 1;
    if count > MAX_EXPANSION as u64 {
        return Err(fail("a range stands for too many addresses"));
    }
    Ok((0..count)
        .map(|i| {
            let value = if from <= to {
                from + i * step
            } else {
                from - i * step
            };
            format!("{value:0width$}")
        })
        .collect())
}

fn letter_values(start: char, end: char) -> Vec<String> {
    let (from, to) = (start as u8, end as u8);
    let letters: Vec<u8> = if from <= to {
        (from..=to).collect()
    } else {
        (to..=from).rev().collect()
    };
    letters
        .into_iter()
        .map(|b| char::from(b).to_string())
        .collect()
}

fn parse_group(inner: &str) -> Result<Option<Vec<String>>> {
    let (range, step) = match inner.split_once(':') {
        Some((range, step)) => (range, Some(step)),
        None => (inner, None),
    };
    let Some((start, end)) = range.split_once('-') else {
        return Ok(None);
    };
    let all_digits =
        |s: &str| !s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_digit());
    if all_digits(start) && all_digits(end) {
        let step = match step {
            None => 1,
            Some(s) if all_digits(s) => s.parse().unwrap_or(0),
            Some(_) => return Ok(None),
        };
        if step == 0 {
            return Err(fail("a range step cannot be 0"));
        }
        return numeric_values(start, end, step).map(Some);
    }
    let single_letter = |s: &str| {
        let mut chars = s.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_alphabetic() => Some(c),
            _ => None,
        }
    };
    match (single_letter(start), single_letter(end), step) {
        (Some(a), Some(b), None) if a.is_ascii_lowercase() == b.is_ascii_lowercase() => {
            Ok(Some(letter_values(a, b)))
        }
        _ => Ok(None),
    }
}

fn pieces(pattern: &str) -> Result<Vec<Piece>> {
    let mut pieces = Vec::new();
    let mut text = String::new();
    let mut rest = pattern;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']').map(|i| open + i) else {
            break;
        };
        match parse_group(&rest[open + 1..close])? {
            Some(values) => {
                text.push_str(&rest[..open]);
                pieces.push(Piece::Text(std::mem::take(&mut text)));
                pieces.push(Piece::Group(values));
            }
            None => text.push_str(&rest[..=close]),
        }
        rest = &rest[close + 1..];
    }
    text.push_str(rest);
    pieces.push(Piece::Text(text));
    Ok(pieces)
}

/// Every address the descriptor stands for, in order; the last group changes fastest.
pub fn expand(pattern: &str) -> Result<Vec<String>> {
    let mut results = vec![String::new()];
    for piece in pieces(pattern)? {
        match piece {
            Piece::Text(text) => results.iter_mut().for_each(|r| r.push_str(&text)),
            Piece::Group(values) => {
                if results.len().saturating_mul(values.len()) > MAX_EXPANSION {
                    return Err(fail("the descriptor stands for too many addresses"));
                }
                results = results
                    .iter()
                    .flat_map(|prefix| values.iter().map(move |v| format!("{prefix}{v}")))
                    .collect();
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_one_address() {
        assert_eq!(expand("https://a/b.jpg").unwrap(), ["https://a/b.jpg"]);
    }

    #[test]
    fn numbers_keep_the_start_padding() {
        assert_eq!(
            expand("https://a/img[08-11].jpg").unwrap(),
            [
                "https://a/img08.jpg",
                "https://a/img09.jpg",
                "https://a/img10.jpg",
                "https://a/img11.jpg"
            ]
        );
        assert_eq!(expand("x[9-11]").unwrap(), ["x9", "x10", "x11"]);
    }

    #[test]
    fn steps_letters_and_descending_ranges() {
        assert_eq!(expand("x[0-10:5]").unwrap(), ["x0", "x5", "x10"]);
        assert_eq!(expand("x[a-c]").unwrap(), ["xa", "xb", "xc"]);
        assert_eq!(expand("x[3-1]").unwrap(), ["x3", "x2", "x1"]);
    }

    #[test]
    fn groups_multiply_with_the_last_changing_fastest() {
        assert_eq!(expand("[1-2]/[a-b]").unwrap(), ["1/a", "1/b", "2/a", "2/b"]);
    }

    #[test]
    fn other_brackets_stay_literal() {
        assert_eq!(
            expand("http://[::1]/a?ids[]=1&x[ok]").unwrap(),
            ["http://[::1]/a?ids[]=1&x[ok]"]
        );
    }

    #[test]
    fn too_many_addresses_and_a_zero_step_are_refused() {
        assert!(expand("x[1-100000]").is_err());
        assert!(expand("[1-30][1-30]").is_err());
        assert!(expand("x[1-5:0]").is_err());
    }
}
