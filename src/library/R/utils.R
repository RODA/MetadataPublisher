# Attach a dedicated helper environment to keep functions off .GlobalEnv
if (!("metadataPublisher" %in% search())) attach(NULL, name = "metadataPublisher")
env <- as.environment("metadataPublisher")

env$keep_attributes <- function(x) {
    # if it's a list or atomic with attributes
    attrs <- attributes(x)
    if (!is.null(attrs)) {
        # remove names that cause circularity
        attrs <- attrs[setdiff(names(attrs), c("names", "class"))]
    }

    if (is.list(x)) {
        # recurse into list children
        x <- lapply(x, keep_attributes)
        nms <- names(x)
        names(x)[nms == ""] <- "value"
        if (length(attrs)) x$.attributes <- attrs
        # Drop empty value nodes (attributes-only)
        if (length(x) == 0) return(list(.attributes = attrs))
        return(x)
    }

    # atomic value
    if (length(attrs)) {
        return(list(value = x, .attributes = attrs))
    }

    return(x)
}

# Normalize a codebook-like nested list into an explicit children-array shape
# Output node shape:
#   list(
#     name = <element name>,
#     attributes = list(...)?,
#     value = <string>? ,
#     children = list(childNode, ...)?
#   )

env$normalize_element <- function(name, x) {
    # Extract and drop meta
    attrs <- NULL
    if (is.list(x)) {
        if (!is.null(x$.attributes)) {
            attrs <- x$.attributes;
            x$.attributes <- NULL
        }

        if (!is.null(x$.extra)) {
            x$.extra <- NULL
        }
    }

    node <- list(name = name)
    if (!is.null(attrs)) node$attributes <- attrs

    # Leaf if x is a list with only `value` (after meta removed)
    if (is.list(x)) {
        nn <- names(x)
        non_meta <- setdiff(nn, c("value"))
        if (length(non_meta) == 0 && "value" %in% nn) {
            node$value <- x$value
            return(node)
        }

        # Otherwise, treat remaining entries as children
        node$children <- normalize_children(x)
        return(node)
    }

    # Fallback: atomic
    node$value <- x
    node
}

env$normalize_children <- function(x) {
    if (!is.list(x)) return(list())
    keys <- names(x)
    # Remove meta keys
    keys <- keys[!(keys %in% c(".attributes", ".extra"))]
    out <- list()
    used <- rep(FALSE, length(keys))

    # Helper to escape regex
    esc <- function(s) gsub("([.^$|()*+?{}\\[\\]\\\\])", "\\\\\\1", s, perl = TRUE)

    for (i in seq_along(keys)) {
        if (used[i]) next
        k <- keys[i]
        base <- sub("\\.\\d+$", "", k, perl = TRUE)
        # all keys with same base or base.N
        rx <- paste0("^", esc(base), "(\\\\.\\\\d+)?$")
        idx <- which(grepl(rx, keys, perl = TRUE))
        used[idx] <- TRUE
        for (j in idx) {
            child_name <- base
            child_val <- x[[ j ]]
            out[[length(out) + 1]] <- normalize_element(child_name, child_val)
        }
    }
    out
}

env$normalize_codebook <- function(cb) {
    # cb is expected from keep_attributes(codeBook)
    cb <- keep_attributes(cb)
    attrs <- NULL
    if (is.list(cb) && !is.null(cb$.attributes)) { attrs <- cb$.attributes; cb$.attributes <- NULL }
    node <- list(name = "codeBook")
    if (!is.null(attrs)) node$attributes <- attrs
    node$children <- normalize_children(cb)
    node
}

env$make_DDI_tree <- function(root = "codeBook") {
        DDIC <- get("DDIC", envir = DDIwR::getEnv())

    if (!is.list(DDIC) || is.null(DDIC[[root]])) {
        admisc::stopError(sprintf("Root element '%s' not found in DDIC.", root))
    }

    # Build a uniform node: list(name = <element>, children = <list-of-nodes>)
    build_node <- function(name, visited) {
        spec <- DDIC[[name]]
        ch <- spec$children

        child_names <- NULL
        if (!is.null(ch) && length(ch) > 0) {
            child_names <- unique(unlist(ch, use.names = FALSE))
        }

        # Build children nodes, skipping visited and unknown elements
        children <- list()
        if (!is.null(child_names) && length(child_names) > 0) {
            for (cn in child_names) {
                if (cn %in% visited || is.null(DDIC[[cn]])) {
                    next
                }
                node <- build_node(cn, c(visited, name))
                if (!is.null(node)) {
                    children[[length(children) + 1]] <- node
                }
            }
        }

        if (length(children) == 0) {
            return(list(name = name, title = spec$title))
        } else {
            return(list(name = name, title = spec$title, children = children))
        }
    }

    # Return the node rooted at `root`
        build_node(root, visited = character())
}

env$dataset_names <- character()

env$import_dataset <- function(name = "current", path) {
    data <- DDIwR::convert(path)
    assign(name, data, envir = .GlobalEnv)
    env$dataset_names <<- unique(c(env$dataset_names, name))
    invisible(data)
}

env$list_datasets <- function() {
    env$dataset_names
}

env$describe_variable <- function(dataset = "current", variable) {
    if (!exists(dataset, envir = .GlobalEnv)) {
        stop("Dataset not loaded: ", dataset)
    }
    data <- get(dataset, envir = .GlobalEnv)
    if (!variable %in% names(data)) {
        stop("Variable not found: ", variable)
    }
    value <- data[[variable]]
    if (is.numeric(value)) {
        return(list(
            min = min(value, na.rm = TRUE),
            max = max(value, na.rm = TRUE),
            mean = mean(value, na.rm = TRUE),
            sd = stats::sd(value, na.rm = TRUE),
            n = sum(!is.na(value))
        ))
    }
    if (is.factor(value) || is.character(value)) {
        return(as.list(as.table(value)))
    }
    list(summary = capture.output(summary(value)))
}

env$ddi_tree_elements <- function() {
    list(
        tree = make_DDI_tree(),
        elements = get("DDIC", envir = DDIwR::getEnv())
    )
}

# Hide the helper reference symbol to avoid polluting the workspace
rm(env)
