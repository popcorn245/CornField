// Package format writes counts for people.
package format

import "strconv"

// Count is "n items"
func Count(n int) string { return strconv.Itoa(n) + " items" }
