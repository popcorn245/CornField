// Package main is the pantry's API.
package main

import (
	"fmt"
	"net/http"

	"example.test/pantry/shared/format"
)

/* An example, not an import:
import "example.test/pantry/tools"
*/

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, format.Count(3))
	})
}
